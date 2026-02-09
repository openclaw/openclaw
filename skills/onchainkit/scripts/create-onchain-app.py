#!/usr/bin/env python3
"""
OnchainKit App Creator

Wrapper around `npm create onchain` with additional customization options.
"""

import argparse
import subprocess
import sys
import os
import json
from pathlib import Path

def run_command(cmd, check=True):
    """Run a command and return the result."""
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"Error running command: {cmd}")
        print(f"stdout: {result.stdout}")
        print(f"stderr: {result.stderr}")
        sys.exit(1)
    return result

def create_onchain_app(project_name, template=None):
    """Create a new OnchainKit app using create-onchain."""
    
    # Base command
    cmd = f"npm create onchain@latest {project_name}"
    
    # Add template if specified
    if template:
        cmd += f" --template {template}"
    
    # Create the project
    print(f"Creating OnchainKit app: {project_name}")
    result = run_command(cmd)
    
    if result.returncode == 0:
        print(f"✅ Successfully created {project_name}")
        return True
    else:
        print(f"❌ Failed to create {project_name}")
        print(f"Error: {result.stderr}")
        return False

def setup_environment_file(project_path):
    """Create a .env.local template file."""
    env_template = """# OnchainKit Configuration
# Get your API key from: https://portal.cdp.coinbase.com/

# Required: Coinbase Developer Platform API Key
NEXT_PUBLIC_CDP_API_KEY=your-api-key-here

# Required: WalletConnect Project ID 
# Get from: https://cloud.walletconnect.com/
NEXT_PUBLIC_WC_PROJECT_ID=your-walletconnect-project-id

# Optional: Chain configuration (defaults to Base mainnet)
NEXT_PUBLIC_CHAIN_ID=8453

# Optional: Enable analytics
NEXT_PUBLIC_ONCHAINKIT_ANALYTICS=true
"""
    
    env_path = project_path / ".env.local.example"
    with open(env_path, 'w') as f:
        f.write(env_template)
    
    print(f"Created environment template: {env_path}")

def add_useful_scripts(project_path):
    """Add helpful package.json scripts."""
    package_json_path = project_path / "package.json"
    
    if not package_json_path.exists():
        print("Warning: package.json not found")
        return
    
    with open(package_json_path, 'r') as f:
        package_data = json.load(f)
    
    # Add useful scripts if they don't exist
    new_scripts = {
        "validate": "node -e \"console.log('OnchainKit setup validation would go here')\"",
        "deploy": "npm run build && echo 'Ready for deployment'",
        "test:e2e": "echo 'E2E tests would go here'"
    }
    
    if "scripts" not in package_data:
        package_data["scripts"] = {}
    
    for script_name, script_cmd in new_scripts.items():
        if script_name not in package_data["scripts"]:
            package_data["scripts"][script_name] = script_cmd
    
    with open(package_json_path, 'w') as f:
        json.dump(package_data, f, indent=2)
    
    print("Added helpful scripts to package.json")

def main():
    parser = argparse.ArgumentParser(
        description="Create a new OnchainKit application with additional setup",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python create-onchain-app.py my-app
  python create-onchain-app.py my-swap-app --template swap
  python create-onchain-app.py my-nft-app --template nft

Available templates:
  - default: Basic onchain app
  - swap: Token swapping interface  
  - nft: NFT minting and viewing
  - commerce: Onchain commerce store
        """
    )
    
    parser.add_argument(
        "project_name",
        help="Name of the project to create"
    )
    
    parser.add_argument(
        "--template", "-t",
        choices=["default", "swap", "nft", "commerce"],
        help="Template to use for the project"
    )
    
    parser.add_argument(
        "--no-setup",
        action="store_true",
        help="Skip additional setup steps"
    )
    
    args = parser.parse_args()
    
    # Validate project name
    if not args.project_name.replace("-", "").replace("_", "").isalnum():
        print("Error: Project name should contain only letters, numbers, hyphens, and underscores")
        sys.exit(1)
    
    # Check if npm is available
    try:
        run_command("npm --version")
    except:
        print("Error: npm is not installed or not in PATH")
        sys.exit(1)
    
    # Create the project
    success = create_onchain_app(args.project_name, args.template)
    
    if not success:
        sys.exit(1)
    
    project_path = Path(args.project_name)
    
    if not args.no_setup:
        print("\nSetting up additional files...")
        
        # Create environment template
        setup_environment_file(project_path)
        
        # Add useful scripts
        add_useful_scripts(project_path)
    
    print(f"""
🎉 OnchainKit app '{args.project_name}' created successfully!

Next steps:
1. cd {args.project_name}
2. Copy .env.local.example to .env.local and add your API keys
3. npm run dev

Get API keys:
- CDP API Key: https://portal.cdp.coinbase.com/
- WalletConnect Project ID: https://cloud.walletconnect.com/

Need help? Run: python validate-setup.py
""")

if __name__ == "__main__":
    main()