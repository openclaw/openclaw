output "state_bucket" {
  value       = aws_s3_bucket.state.bucket
  description = "Terraform state bucket name."
}

output "state_lock_table" {
  value       = aws_dynamodb_table.lock.name
  description = "Terraform state lock table name."
}
