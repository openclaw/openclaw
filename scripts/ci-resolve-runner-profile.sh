#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail
runner_profile="${CONFIGURED_RUNNER_PROFILE:-blacksmith}"
case "$runner_profile" in
  github | hybrid | blacksmith | runson | boat) ;;
  *) echo "OPENCLAW_CI_RUNNER_BACKEND must be github, hybrid, blacksmith, runson, or boat" >&2; exit 1 ;;
esac
ci_qualification=false
ci_shape=default
if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" && "${QUALIFICATION_DISPATCH:-false}" == "true" ]]; then
  ci_qualification=true
  ci_shape="${CI_SHAPE:-default}"
  if [[ "${REQUESTED_RUNNER_PROFILE:-default}" != "default" ]]; then
    runner_profile="$REQUESTED_RUNNER_PROFILE"
  fi
elif [[ "${REQUESTED_RUNNER_PROFILE:-default}" != "default" || "${CI_SHAPE:-default}" != "default" ]]; then
  echo "Runner and shape overrides require an admitted CI qualification" >&2
  exit 1
fi
boat_requested=false
if [[ "$runner_profile" == "boat" ]]; then
  boat_requested=true
  # Hybrid owns the logical plan; Boat is a final physical projection.
  runner_profile=hybrid
fi
runson_requested=false
if [[ "$runner_profile" == "runson" || "${REQUESTED_RUNNER_PROFILE:-default}" == "runson" ]]; then
  runson_requested=true
  runner_profile=hybrid
fi
qualified_runner_profile="$runner_profile"
hosted_runner_profile_contract=false
grep -Fq "hosted-runner-profile-contract-v1" .github/workflows/ci.yml &&
  hosted_runner_profile_contract=true
fork_pull_request=false
[[ "$GITHUB_EVENT_NAME" == "pull_request" && "$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY" ]] &&
  fork_pull_request=true
# Forks cannot mount the trusted sticky disks and caches that size the
# all-in-one lint/type jobs, so their check jobs keep the hosted stripes.
if [[
  "$hosted_runner_profile_contract" == "true" &&
  (
    "$GITHUB_EVENT_NAME" == "workflow_dispatch" ||
    "$GITHUB_REPOSITORY" != "openclaw/openclaw" ||
    "$fork_pull_request" == "true"
  )
]]; then
  runner_profile=github
fi
node_runner_backend="$runner_profile"
qualification_runner_backend=
if [[ "$ci_qualification" == "true" && "${GITHUB_RUN_ATTEMPT:-1}" == "1" ]]; then
  runner_profile="$qualified_runner_profile"
  node_runner_backend="$qualified_runner_profile"
  qualification_runner_backend="$qualified_runner_profile"
fi
# Ordinary pushes retain hybrid; only admitted qualification may opt in on a main shape.
if [[ "$runson_requested" == "true" && "$GITHUB_REPOSITORY" == "openclaw/openclaw" && "${GITHUB_RUN_ATTEMPT:-1}" == "1" ]] &&
  grep -Fq "runson-runner-profile-contract-v1" .github/workflows/ci.yml &&
  [[ ( "$GITHUB_EVENT_NAME" == "pull_request" && "$HEAD_REPOSITORY" == "$GITHUB_REPOSITORY" ) || "$ci_qualification" == "true" ]]; then
  runner_profile=hybrid
  node_runner_backend=runson
fi
effective_runner_backend="${CONFIGURED_RUNNER_PROFILE:-blacksmith}"
boat_node_job_limit=
if [[ "$ci_qualification" == "true" ]]; then
  effective_runner_backend=github
  [[ "${GITHUB_RUN_ATTEMPT:-1}" != "1" ]] || effective_runner_backend="$qualification_runner_backend"
fi
if [[ "$boat_requested" == "true" ]]; then
  author="${SOURCE_AUTHOR:-}"
  boat_users=" davemorin jalehman joshavant steipete vincentkoc "
  if [[ "$GITHUB_REPOSITORY" == "openclaw/openclaw" && "$fork_pull_request" == "false" && "${GITHUB_RUN_ATTEMPT:-1}" == "1" && "$boat_users" == *" $author "* && "$boat_users" == *" ${GITHUB_TRIGGERING_ACTOR:-$GITHUB_ACTOR} "* ]]; then
    runner_profile=hybrid
    node_runner_backend=boat
    effective_runner_backend=boat
    if [[ "$ci_qualification" == "false" ]]; then
      # Ordinary CI shares a start allowance; only its longest Node
      # rows use Boat. Other work retains the hybrid overflow route.
      node_runner_backend=hybrid
      effective_runner_backend=hybrid
      boat_node_job_limit="$(node --input-type=module <<'JS'
const key = process.env.BOAT_API_KEY;
const org = process.env.BOAT_ORG;
let budget = 0;
try {
  if (!key || !org) throw new Error('missing account scope');
  const { resolveBoatNodeJobBudget } = await import('./.ci-harness/scripts/lib/ci-node-test-capacity.mts');
  const response = await fetch('https://boat.dev/api/v1/limits', {
    headers: { Authorization: `Bearer ${key}`, 'X-Boat-Org': org },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('limits unavailable');
  const limits = await response.json();
  if (limits.teamId !== org) throw new Error('account scope mismatch');
  budget = resolveBoatNodeJobBudget(limits);
} catch {
  console.error('::warning::Boat limits unavailable; using hybrid CI.');
}
console.log(budget);
JS
      )"
      echo "Boat admission: up to $boat_node_job_limit Node jobs; remaining jobs use hybrid CI."
    fi
  else
    runner_profile=github
    node_runner_backend=github
    effective_runner_backend=github
  fi
fi
# Forks cannot rely on repository variables or trusted provider credentials.
if [[ "$fork_pull_request" == "true" && "$GITHUB_REPOSITORY" == "openclaw/openclaw" ]]; then
  runner_profile=github
  node_runner_backend=github
  effective_runner_backend=github
fi
placement_runner_backend="$effective_runner_backend"
[[ "$placement_runner_backend" != "boat" ]] || placement_runner_backend=hybrid
if [[ "$boat_requested" == "true" && "$ci_qualification" == "true" ]]; then
  qualification_runner_backend="$placement_runner_backend"
fi
printf '%s\n' \
  "hosted_runner_profile_contract=$hosted_runner_profile_contract" \
  "ci_qualification=$ci_qualification" \
  "ci_shape=$ci_shape" \
  "qualification_runner_backend=$qualification_runner_backend" \
  "effective_runner_backend=$effective_runner_backend" \
  "placement_runner_backend=$placement_runner_backend" \
  "runner_profile=$runner_profile" \
  "node_runner_backend=$node_runner_backend" >> "$GITHUB_OUTPUT"
if [[ -n "$boat_node_job_limit" ]]; then
  echo "boat_node_job_limit=$boat_node_job_limit" >> "$GITHUB_OUTPUT"
fi
