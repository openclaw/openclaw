# Container Registry - Using existing registry (edith-registry)
# DigitalOcean only allows one registry per account on Basic plan
# We'll push OpenClaw image as a new repository in the existing registry

# Reference existing registry by name
variable "existing_registry_name" {
  description = "Name of existing DigitalOcean container registry"
  type        = string
  default     = "edith-registry"
}

# Output the registry endpoint
output "registry_endpoint" {
  description = "Container registry endpoint"
  value       = "registry.digitalocean.com/${var.existing_registry_name}"
}

output "registry_name" {
  description = "Container registry name"
  value       = var.existing_registry_name
}
