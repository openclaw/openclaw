#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-3}}"
AWS_PROFILE="${AWS_PROFILE:-}"
EKS_CLUSTER_NAMES="${EKS_CLUSTER_NAMES:-}"
AWS_TIMEOUT_SECONDS="${AWS_TIMEOUT_SECONDS:-10}"

echo -e "resource_type\tresource_id\tstatus\tutilization_pct\tnotes"

if ! command -v aws >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo -e "collector\tdeps\tunknown\tn/a\tmissing_aws_or_jq"
  exit 0
fi

aws_cmd() {
  local args=(--region "$AWS_REGION")
  if [[ -n "$AWS_PROFILE" ]]; then
    args+=(--profile "$AWS_PROFILE")
  fi
  AWS_PAGER="" aws "${args[@]}" "$@"
}

if ! timeout "$AWS_TIMEOUT_SECONDS" aws_cmd sts get-caller-identity >/dev/null 2>&1; then
  echo -e "aws_auth\tcaller\tunknown\tn/a\tunable_to_assume_role"
  exit 0
fi

collect_instance_ids() {
  if command -v kubectl >/dev/null 2>&1; then
    kubectl get nodes -o json 2>/dev/null \
      | jq -r '.items[]?.spec.providerID // empty' 2>/dev/null \
      | sed -E 's#^.*/(i-[a-zA-Z0-9]+)$#\1#' \
      | awk '/^i-[a-zA-Z0-9]+$/ {print}' \
      | sort -u
  fi
}

instance_ids="$(collect_instance_ids || true)"
if [[ -z "$instance_ids" && -n "${AWS_INSTANCE_IDS:-}" ]]; then
  instance_ids="$(printf '%s' "$AWS_INSTANCE_IDS" | tr ',' '\n' | awk 'NF>0{print}' | sort -u)"
fi

if [[ -n "$instance_ids" ]]; then
  instance_id_args=()
  while IFS= read -r iid; do
    [[ -n "$iid" ]] && instance_id_args+=("$iid")
  done <<<"$instance_ids"

  if [[ "${#instance_id_args[@]}" -gt 0 ]]; then
    ec2_status_json="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd ec2 describe-instance-status --include-all-instances --instance-ids "${instance_id_args[@]}" 2>/dev/null || true)"

    if [[ -n "$ec2_status_json" ]]; then
      while IFS=$'\t' read -r iid sys_status inst_status; do
        [[ -z "$iid" ]] && continue
        status="ok"
        if [[ "$sys_status" != "ok" || "$inst_status" != "ok" ]]; then
          if [[ "$sys_status" == "impaired" || "$inst_status" == "impaired" ]]; then
            status="critical"
          else
            status="warning"
          fi
        fi
        echo -e "ec2-instance\t${iid}\t${status}\tn/a\tsystem=${sys_status};instance=${inst_status}"
      done < <(
        printf '%s\n' "$ec2_status_json" | jq -r '
          .InstanceStatuses[]?
          | [.InstanceId, (.SystemStatus.Status // "unknown"), (.InstanceStatus.Status // "unknown")]
          | @tsv
        '
      )

      volume_ids="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd ec2 describe-instances --instance-ids "${instance_id_args[@]}" 2>/dev/null \
        | jq -r '.Reservations[]?.Instances[]?.BlockDeviceMappings[]?.Ebs?.VolumeId // empty' | sort -u || true)"
      if [[ -n "$volume_ids" ]]; then
        volume_args=()
        while IFS= read -r vid; do
          [[ -n "$vid" ]] && volume_args+=("$vid")
        done <<<"$volume_ids"
        if [[ "${#volume_args[@]}" -gt 0 ]]; then
          volume_status_json="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd ec2 describe-volume-status --volume-ids "${volume_args[@]}" 2>/dev/null || true)"
          if [[ -n "$volume_status_json" ]]; then
            while IFS=$'\t' read -r vid io_status vol_status; do
              [[ -z "$vid" ]] && continue
              status="ok"
              if [[ "$io_status" != "ok" || "$vol_status" != "ok" ]]; then
                if [[ "$io_status" == "impaired" || "$vol_status" == "impaired" ]]; then
                  status="critical"
                else
                  status="warning"
                fi
              fi
              echo -e "ebs-volume\t${vid}\t${status}\tn/a\tio=${io_status};volume=${vol_status}"
            done < <(
              printf '%s\n' "$volume_status_json" | jq -r '
                .VolumeStatuses[]?
                | [
                    .VolumeId,
                    (.Actions[]?.Code // .IoPerformanceStatus // "unknown"),
                    (.VolumeStatus.Status // "unknown")
                  ]
                | @tsv
              '
            )
          else
            echo -e "ebs-volume\tdiscovery\tunknown\tn/a\tvolume_status_unavailable"
          fi
        fi
      fi

      spot_notice_json="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd ec2 describe-instance-status --instance-ids "${instance_id_args[@]}" 2>/dev/null || true)"
      spot_events="$(printf '%s\n' "$spot_notice_json" | jq -r '
        .InstanceStatuses[]?
        | select((.Events // []) | length > 0)
        | [.InstanceId, (.Events[0].Code // "scheduled")]
        | @tsv
      ' || true)"
      if [[ -n "$spot_events" ]]; then
        while IFS=$'\t' read -r iid code; do
          [[ -z "$iid" ]] && continue
          echo -e "spot-interruption\t${iid}\tcritical\tn/a\tevent=${code}"
        done <<<"$spot_events"
      fi
    else
      echo -e "ec2-instance\tdiscovery\tunknown\tn/a\tdescribe_instance_status_failed"
    fi
  fi
else
  echo -e "ec2-instance\tnone\tunknown\tn/a\tno_instance_ids"
fi

cluster_names="$EKS_CLUSTER_NAMES"
if [[ -z "$cluster_names" ]]; then
  cluster_names="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd eks list-clusters 2>/dev/null | jq -r '.clusters[]?' | head -n 5 || true)"
fi

if [[ -n "$cluster_names" ]]; then
  while IFS= read -r cluster; do
    [[ -z "$cluster" ]] && continue
    nodegroups_json="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd eks list-nodegroups --cluster-name "$cluster" 2>/dev/null || true)"
    if [[ -z "$nodegroups_json" ]]; then
      echo -e "eks-nodegroup\t${cluster}/discovery\tunknown\tn/a\tlist_nodegroups_failed"
      continue
    fi

    while IFS= read -r ng; do
      [[ -z "$ng" ]] && continue
      ng_json="$(timeout "$AWS_TIMEOUT_SECONDS" aws_cmd eks describe-nodegroup --cluster-name "$cluster" --nodegroup-name "$ng" 2>/dev/null || true)"
      if [[ -z "$ng_json" ]]; then
        echo -e "eks-nodegroup\t${cluster}/${ng}\tunknown\tn/a\tdescribe_nodegroup_failed"
        continue
      fi

      status_raw="$(printf '%s\n' "$ng_json" | jq -r '.nodegroup.status // "UNKNOWN"')"
      desired="$(printf '%s\n' "$ng_json" | jq -r '.nodegroup.scalingConfig.desiredSize // 0')"
      min_size="$(printf '%s\n' "$ng_json" | jq -r '.nodegroup.scalingConfig.minSize // 0')"
      max_size="$(printf '%s\n' "$ng_json" | jq -r '.nodegroup.scalingConfig.maxSize // 0')"
      issue_codes="$(printf '%s\n' "$ng_json" | jq -r '[.nodegroup.health.issues[]?.code] | join(",")')"

      mapped_status="ok"
      case "$status_raw" in
        ACTIVE) mapped_status="ok" ;;
        DEGRADED|UPDATING|CREATING|DELETING) mapped_status="warning" ;;
        CREATE_FAILED|DELETE_FAILED) mapped_status="critical" ;;
        *) mapped_status="unknown" ;;
      esac

      util="n/a"
      if [[ "$max_size" =~ ^[0-9]+$ ]] && (( max_size > 0 )); then
        util="$(awk -v d="$desired" -v m="$max_size" 'BEGIN { printf "%.1f", (d/m)*100 }')"
      fi

      notes="status=${status_raw};desired=${desired};min=${min_size};max=${max_size}"
      if [[ -n "$issue_codes" ]]; then
        notes="${notes};issues=${issue_codes}"
      fi
      if [[ "$util" == "n/a" ]]; then
        echo -e "eks-nodegroup\t${cluster}/${ng}\t${mapped_status}\tn/a\t${notes}"
      else
        echo -e "eks-nodegroup\t${cluster}/${ng}\t${mapped_status}\t${util}%\t${notes}"
      fi
    done < <(printf '%s\n' "$nodegroups_json" | jq -r '.nodegroups[]?' 2>/dev/null || true)
  done <<<"$cluster_names"
else
  echo -e "eks-nodegroup\tnone\tunknown\tn/a\tno_cluster_discovery"
fi
