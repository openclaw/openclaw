variable "region" {
  type        = string
  description = "AWS region for all resources."
  default     = "eu-central-1"
}

variable "name_prefix" {
  type        = string
  description = "Resource name prefix."
  default     = "openclaw"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type."
  default     = "t3.medium"
}

variable "ami_id" {
  type        = string
  description = "Optional AMI id override."
  default     = ""
}

variable "ami_arch" {
  type        = string
  description = "AMI architecture (x86_64 or arm64) used when ami_id is empty."
  default     = "x86_64"
}

variable "vpc_id" {
  type        = string
  description = "Optional VPC id override. Uses the default VPC when unset."
  default     = ""
}

variable "subnet_id" {
  type        = string
  description = "Optional subnet id override. Uses the first default subnet when unset."
  default     = ""
}

variable "ssh_allowed_cidrs" {
  type        = list(string)
  description = "Optional CIDR blocks allowed to SSH (port 22). Empty disables SSH ingress."
  default     = []
}

variable "ssh_key_name" {
  type        = string
  description = "Optional EC2 key pair name for SSH access."
  default     = ""
}

variable "gateway_allowed_cidrs" {
  type        = list(string)
  description = "Optional CIDR blocks allowed to reach the gateway port (18789). Empty keeps it private."
  default     = []
}

variable "root_volume_size_gb" {
  type        = number
  description = "Root volume size in GB."
  default     = 20
}

variable "openclaw_data_volume_size_gb" {
  type        = number
  description = "Persistent data volume size in GB for /var/lib/openclaw."
  default     = 50
}

variable "openclaw_data_volume_type" {
  type        = string
  description = "Persistent data volume type."
  default     = "gp3"
}

variable "openclaw_secret_name" {
  type        = string
  description = "Secrets Manager secret name containing OpenClaw config and env."
  default     = "openclaw/prod"
}

variable "tf_state_bucket" {
  type        = string
  description = "Terraform state S3 bucket name."
  default     = "openclaw-tfstate-aron98"
}

variable "tf_state_lock_table" {
  type        = string
  description = "Terraform state DynamoDB lock table name."
  default     = "openclaw-tf-lock"
}

variable "github_owner" {
  type        = string
  description = "GitHub org/user for OIDC trust."
  default     = "aron98"
}

variable "github_repo" {
  type        = string
  description = "GitHub repo for OIDC trust."
  default     = "openclaw"
}

variable "github_actions_role_name" {
  type        = string
  description = "IAM role name for GitHub Actions OIDC."
  default     = "openclaw-github-oidc"
}

variable "oidc_provider_arn" {
  type        = string
  description = "Existing GitHub OIDC provider ARN. If set, no provider is created."
  default     = ""
}

variable "github_oidc_thumbprints" {
  type        = list(string)
  description = "Thumbprints for the GitHub Actions OIDC provider."
  default     = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

variable "openclaw_repo_url" {
  type        = string
  description = "Git repo URL for the OpenClaw source checkout."
  default     = "https://github.com/aron98/openclaw.git"
}

variable "openclaw_repo_ref" {
  type        = string
  description = "Git ref (branch/tag) to deploy from the OpenClaw repo."
  default     = "main"
}
