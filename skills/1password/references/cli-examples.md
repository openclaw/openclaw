# op CLI examples (from op help)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sign in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op signin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op signin --account <shorthand|signin-address|account-id|user-id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Read（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op read op://app-prod/db/password`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op read "op://app-prod/db/one-time password?attribute=otp"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op read "op://app-prod/ssh key/private key?ssh-format=openssh"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op read --out-file ./key.pem op://app-prod/server/ssh/key.pem`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `export DB_PASSWORD="op://app-prod/db/password"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op run --no-masking -- printenv DB_PASSWORD`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op run --env-file="./.env" -- printenv DB_PASSWORD`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inject（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `echo "db_password: {{ op://app-prod/db/password }}" | op inject`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op inject -i config.yml.tpl -o config.yml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Whoami / accounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op whoami`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `op account list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
