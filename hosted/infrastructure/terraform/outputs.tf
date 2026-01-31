# Output the registry details
output "registry_endpoint" {
  description = "Container registry endpoint for pushing images"
  value       = "registry.digitalocean.com/${var.existing_registry_name}"
}

output "registry_name" {
  description = "Container registry name"
  value       = var.existing_registry_name
}

output "image_url" {
  description = "Full image URL for OpenClaw"
  value       = "registry.digitalocean.com/${var.existing_registry_name}/openclaw:latest"
}
