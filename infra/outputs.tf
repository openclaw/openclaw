output "instance_id" {
  value       = aws_instance.openclaw.id
  description = "EC2 instance id."
}

output "instance_private_ip" {
  value       = aws_instance.openclaw.private_ip
  description = "EC2 private IP."
}

output "openclaw_secret_arn" {
  value       = aws_secretsmanager_secret.openclaw.arn
  description = "Secrets Manager secret ARN for OpenClaw config."
}

output "openclaw_data_volume_id" {
  value       = aws_ebs_volume.openclaw_data.id
  description = "Persistent data volume id for /var/lib/openclaw."
}

output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions.arn
  description = "IAM role ARN for GitHub Actions OIDC."
}

output "state_bucket" {
  value       = var.tf_state_bucket
  description = "Terraform state bucket name."
}

output "state_lock_table" {
  value       = var.tf_state_lock_table
  description = "Terraform state lock table name."
}
