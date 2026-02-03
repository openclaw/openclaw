variable "region" {
  type        = string
  description = "AWS region for the state backend."
  default     = "eu-central-1"
}

variable "state_bucket_name" {
  type        = string
  description = "S3 bucket name for Terraform state."
  default     = "openclaw-tfstate-aron98"
}

variable "state_lock_table_name" {
  type        = string
  description = "DynamoDB table name for Terraform state locking."
  default     = "openclaw-tf-lock"
}
