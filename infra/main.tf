provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.subnet_id == "" ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_subnet" "selected" {
  id = local.subnet_id
}

data "aws_ami" "al2023" {
  count       = var.ami_id == "" ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-${var.ami_arch}"]
  }

  filter {
    name   = "architecture"
    values = [var.ami_arch]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  vpc_id    = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
  subnet_id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default[0].ids[0]
  ami_id    = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023[0].id
}

resource "aws_secretsmanager_secret" "openclaw" {
  name = var.openclaw_secret_name

  tags = {
    Name        = "${var.name_prefix}-secret"
    Environment = "prod"
  }
}

resource "aws_security_group" "openclaw" {
  name        = "${var.name_prefix}-sg"
  description = "OpenClaw gateway security group"
  vpc_id      = local.vpc_id

  dynamic "ingress" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_allowed_cidrs
    }
  }

  dynamic "ingress" {
    for_each = length(var.gateway_allowed_cidrs) > 0 ? [1] : []
    content {
      description = "OpenClaw Gateway"
      from_port   = 18789
      to_port     = 18789
      protocol    = "tcp"
      cidr_blocks = var.gateway_allowed_cidrs
    }
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = {
    Name        = "${var.name_prefix}-sg"
    Environment = "prod"
  }
}

data "aws_iam_policy_document" "openclaw_instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "openclaw_instance" {
  name               = "${var.name_prefix}-instance"
  assume_role_policy = data.aws_iam_policy_document.openclaw_instance_assume.json

  tags = {
    Name        = "${var.name_prefix}-instance"
    Environment = "prod"
  }
}

data "aws_iam_policy_document" "openclaw_secret_access" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.openclaw.arn]
  }
}

resource "aws_iam_role_policy" "openclaw_secret_access" {
  name   = "${var.name_prefix}-secret-access"
  role   = aws_iam_role.openclaw_instance.id
  policy = data.aws_iam_policy_document.openclaw_secret_access.json
}

resource "aws_iam_role_policy_attachment" "openclaw_ssm" {
  role       = aws_iam_role.openclaw_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "openclaw" {
  name = "${var.name_prefix}-instance"
  role = aws_iam_role.openclaw_instance.name
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.oidc_provider_arn == "" ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.github_oidc_thumbprints

  tags = {
    Name        = "${var.name_prefix}-github-oidc"
    Environment = "prod"
  }
}

locals {
  github_oidc_provider_arn = var.oidc_provider_arn != "" ? var.oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = var.github_actions_role_name
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json

  tags = {
    Name        = var.github_actions_role_name
    Environment = "prod"
  }
}

data "aws_iam_policy_document" "github_actions" {
  statement {
    actions = [
      "ec2:AllocateAddress",
      "ec2:AssociateAddress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:CreateNetworkInterface",
      "ec2:CreateSecurityGroup",
      "ec2:CreateTags",
      "ec2:DeleteNetworkInterface",
      "ec2:DeleteSecurityGroup",
      "ec2:DeleteTags",
      "ec2:DescribeImages",
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeTags",
      "ec2:DescribeVpcs",
      "ec2:DisassociateAddress",
      "ec2:ModifyInstanceAttribute",
      "ec2:RebootInstances",
      "ec2:ReleaseAddress",
      "ec2:RunInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:TerminateInstances",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress"
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "iam:AddRoleToInstanceProfile",
      "iam:AttachRolePolicy",
      "iam:CreateInstanceProfile",
      "iam:CreateOpenIDConnectProvider",
      "iam:CreateRole",
      "iam:DeleteInstanceProfile",
      "iam:DeleteOpenIDConnectProvider",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetInstanceProfile",
      "iam:GetOpenIDConnectProvider",
      "iam:GetRole",
      "iam:ListInstanceProfilesForRole",
      "iam:ListOpenIDConnectProviders",
      "iam:PutRolePolicy",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagOpenIDConnectProvider",
      "iam:TagRole",
      "iam:UntagOpenIDConnectProvider",
      "iam:UntagRole"
    ]
    resources = ["*"]
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.openclaw_instance.arn]
  }

  statement {
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:UpdateSecret"
    ]
    resources = ["arn:aws:secretsmanager:${var.region}:*:secret:${var.openclaw_secret_name}*"]
  }

  statement {
    actions = [
      "ssm:DescribeInstanceInformation",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:ListCommands",
      "ssm:SendCommand"
    ]
    resources = ["*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.tf_state_bucket}"]
  }

  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]
    resources = ["arn:aws:s3:::${var.tf_state_bucket}/*"]
  }

  statement {
    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:UpdateItem"
    ]
    resources = ["arn:aws:dynamodb:${var.region}:*:table/${var.tf_state_lock_table}"]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "${var.name_prefix}-github-actions"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions.json
}

resource "aws_ebs_volume" "openclaw_data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = var.openclaw_data_volume_size_gb
  type              = var.openclaw_data_volume_type
  encrypted         = true

  tags = {
    Name        = "${var.name_prefix}-data"
    Environment = "prod"
  }
}

resource "aws_instance" "openclaw" {
  ami                         = local.ami_id
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.openclaw.id]
  key_name                    = var.ssh_key_name != "" ? var.ssh_key_name : null
  iam_instance_profile        = aws_iam_instance_profile.openclaw.name
  user_data                   = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    aws_region         = var.region
    openclaw_config     = file("${path.module}/openclaw.json")
    openclaw_secret_id = aws_secretsmanager_secret.openclaw.arn
    openclaw_data_volume_id = aws_ebs_volume.openclaw_data.id
    openclaw_state_dir = "/var/lib/openclaw"
    openclaw_repo_url   = var.openclaw_repo_url
    openclaw_repo_ref   = var.openclaw_repo_ref
  })
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = {
    Name        = "${var.name_prefix}-gateway"
    Environment = "prod"
  }
}

resource "aws_volume_attachment" "openclaw_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.openclaw_data.id
  instance_id = aws_instance.openclaw.id
}
