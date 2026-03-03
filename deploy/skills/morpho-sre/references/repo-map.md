# Morpho SRE Repo Map

## Primary Infra Repos

- `/Users/florian/morpho/morpho-infra`
- `/Users/florian/morpho/morpho-infra-helm`
- `morpho-infra/projects/commons` is the authoritative ECR repo -> GitHub repo map.

## ECR Mapping Source

- `morpho-infra/projects/commons/variables.auto.tfvars`:
  - `github_repositories`
  - `ecr_repository_mapping`

## Common Mapping Pattern

- Runtime image in pod -> image repository (strip tag/digest) -> map via commons ECR mapping.
- Non-ECR images default to `morpho-org/morpho-infra` as infra source-of-truth.
- `definition_hit` points to first matching file/line in infra repos.

## Script Output Files

- `/tmp/openclaw-image-repo/image-repo-map.tsv`
- `/tmp/openclaw-image-repo/workload-image-repo.tsv`
- Includes `local_repo_path` for immediate on-pod investigation when GitHub clone token is insufficient.

## Helper Scripts

- Clone/update repo mirror: `scripts/repo-clone.sh`
- Read latest workflow runs: `scripts/github-ci-status.sh`
