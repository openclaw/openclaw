# Azure Terraform Reference

## Provider Block

```hcl
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
  cloud {
    organization = "<TFC_ORG>"
    workspaces {
      name = "<TFC_WORKSPACE_AZURE>"
    }
  }
}

provider "azurerm" {
  features {}
}
```

Credentials (`ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID`) are set as TFC workspace env vars — never in `.tf` files.

---

## Common Resources

### Resource Group (always first)

```hcl
resource "azurerm_resource_group" "this" {
  name     = "${var.project}-${var.environment}-rg"
  location = var.location
  tags     = local.tags
}
```

### Virtual Network + Subnets

```hcl
resource "azurerm_virtual_network" "this" {
  name                = "${var.project}-vnet"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  address_space       = [var.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "this" {
  name                 = "${var.project}-subnet"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [var.subnet_cidr]
}
```

### Storage Account

```hcl
resource "azurerm_storage_account" "this" {
  name                     = var.storage_account_name  # globally unique, lowercase, max 24 chars
  resource_group_name      = azurerm_resource_group.this.name
  location                 = azurerm_resource_group.this.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = local.tags
}

resource "azurerm_storage_container" "this" {
  name                  = var.container_name
  storage_account_name  = azurerm_storage_account.this.name
  container_access_type = "private"
}
```

### Azure SQL Database

```hcl
resource "azurerm_mssql_server" "this" {
  name                         = "${var.project}-sqlserver"
  resource_group_name          = azurerm_resource_group.this.name
  location                     = azurerm_resource_group.this.location
  version                      = "12.0"
  administrator_login          = var.sql_admin
  administrator_login_password = var.sql_password  # SECURITY: Set as sensitive TFC workspace variable, never commit actual value

  tags                         = local.tags
}

resource "azurerm_mssql_database" "this" {
  name      = var.db_name
  server_id = azurerm_mssql_server.this.id
  sku_name  = "S0"
  tags      = local.tags
}
```

### Linux VM

```hcl
resource "azurerm_linux_virtual_machine" "this" {
  name                = "${var.project}-vm"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  size                = var.vm_size
  admin_username      = var.admin_username

  network_interface_ids = [azurerm_network_interface.this.id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts"
    version   = "latest"
  }
  tags = local.tags
}
```

### AKS Cluster

```hcl
resource "azurerm_kubernetes_cluster" "this" {
  name                = "${var.project}-aks"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  dns_prefix          = var.project

  default_node_pool {
    name       = "default"
    node_count = var.node_count
    vm_size    = "Standard_D2_v2"
  }

  identity {
    type = "SystemAssigned"
  }
  tags = local.tags
}
```

### Azure Function App

```hcl
resource "azurerm_service_plan" "this" {
  name                = "${var.project}-plan"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = "Y1"  # Consumption plan
}

resource "azurerm_linux_function_app" "this" {
  name                       = "${var.project}-func"
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  storage_account_name       = azurerm_storage_account.this.name
  storage_account_access_key = azurerm_storage_account.this.primary_access_key  # SECURITY: Consider using managed identity instead of access keys

  service_plan_id            = azurerm_service_plan.this.id

  site_config {
    application_stack { python_version = "3.11" }
  }
  tags = local.tags
}
```

---

## Locals (always include)

```hcl
locals {
  tags = {
    ManagedBy   = "terraform"
    Environment = var.environment
    Project     = var.project
  }
}
```

## Variables Template

```hcl
variable "environment" { default = "dev" }
variable "project"     { default = "myproject" }
variable "location"    { default = "eastus" }
```

## Outputs Template

```hcl
output "resource_group_name" { value = azurerm_resource_group.this.name }
output "vnet_id"             { value = azurerm_virtual_network.this.id }
```
