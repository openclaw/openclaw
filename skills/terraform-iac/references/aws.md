# AWS Terraform Reference

## Provider Block

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  cloud {
    organization = "<TFC_ORG>"
    workspaces {
      name = "<TFC_WORKSPACE_AWS>"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  default = "us-east-1"
}
```

Credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are set as TFC workspace env vars — never in `.tf` files.

---

## Common Resources

### S3 Bucket

```hcl
resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
```

### VPC + Subnets

```hcl
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  tags                 = local.tags
}

resource "aws_subnet" "public" {
  count             = length(var.public_subnets)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.public_subnets[count.index]
  availability_zone = var.azs[count.index]
  tags              = merge(local.tags, { Name = "public-${count.index}" })
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnets)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnets[count.index]
  availability_zone = var.azs[count.index]
  tags              = merge(local.tags, { Name = "private-${count.index}" })
}
```

### EC2 Instance

```hcl
resource "aws_instance" "this" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.this.id]
  tags                   = local.tags
}
```

### RDS (PostgreSQL)

```hcl
resource "aws_db_instance" "this" {
  identifier        = var.db_name
  engine            = "postgres"
  engine_version    = "15"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  db_name           = var.db_name
  username          = var.db_username
  password          = var.db_password  # SECURITY: Set as sensitive TFC workspace variable, never commit actual value

  skip_final_snapshot = true
  tags              = local.tags
}
```

### Lambda

```hcl
resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "python3.12"
  filename      = var.zip_path
  tags          = local.tags
}
```

### EKS Cluster

```hcl
resource "aws_eks_cluster" "this" {
  name     = var.cluster_name
  role_arn = aws_iam_role.eks.arn
  version  = "1.30"

  vpc_config {
    subnet_ids = aws_subnet.private[*].id
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
variable "aws_region"  { default = "us-east-1" }
```

## Outputs Template

```hcl
output "vpc_id"     { value = aws_vpc.this.id }
output "bucket_arn" { value = aws_s3_bucket.this.arn }
```
