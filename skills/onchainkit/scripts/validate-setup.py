#!/usr/bin/env python3
"""
OnchainKit Setup Validator

Validates that an OnchainKit project is properly configured and ready for development.
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from urllib.parse import urlparse

def check_with_status(check_name, check_function):
    """Run a check function and print status."""
    print(f"🔍 {check_name}...", end=" ")
    try:
        result = check_function()
        if result:
            print("✅")
            return True
        else:
            print("❌")
            return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def check_project_structure():
    """Check if we're in a valid Node.js project."""
    package_json = Path("package.json")
    if not package_json.exists():
        print("No package.json found")
        return False
    
    try:
        with open(package_json) as f:
            data = json.load(f)
        return True
    except:
        print("Invalid package.json")
        return False

def check_onchainkit_installed():
    """Check if OnchainKit is installed."""
    try:
        result = subprocess.run(["npm", "ls", "@coinbase/onchainkit"], 
                              capture_output=True, text=True)
        return result.returncode == 0
    except:
        return False

def check_required_dependencies():
    """Check if required peer dependencies are installed."""
    required_deps = ["react", "react-dom", "viem", "wagmi"]
    
    try:
        for dep in required_deps:
            result = subprocess.run(["npm", "ls", dep], 
                                  capture_output=True, text=True)
            if result.returncode != 0:
                print(f"Missing required dependency: {dep}")
                return False
        return True
    except:
        return False

def check_env_file():
    """Check if .env.local exists and has required variables."""
    env_path = Path(".env.local")
    if not env_path.exists():
        print(".env.local not found")
        return False
    
    required_vars = ["NEXT_PUBLIC_CDP_API_KEY", "NEXT_PUBLIC_WC_PROJECT_ID"]
    
    with open(env_path) as f:
        content = f.read()
    
    for var in required_vars:
        if var not in content:
            print(f"Missing environment variable: {var}")
            return False
    
    return True

def check_api_keys():
    """Validate API key formats."""
    env_path = Path(".env.local")
    if not env_path.exists():
        return False
    
    env_vars = {}
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env_vars[key] = value
    
    # Check CDP API key format
    cdp_key = env_vars.get("NEXT_PUBLIC_CDP_API_KEY", "")
    if cdp_key in ["", "your-api-key-here"] or len(cdp_key) < 10:
        print("CDP API key appears to be placeholder or invalid")
        return False
    
    # Check WalletConnect project ID format  
    wc_id = env_vars.get("NEXT_PUBLIC_WC_PROJECT_ID", "")
    if wc_id in ["", "your-walletconnect-project-id"] or len(wc_id) < 10:
        print("WalletConnect project ID appears to be placeholder or invalid")
        return False
    
    return True

def check_npm_scripts():
    """Check if useful npm scripts are available."""
    package_json = Path("package.json")
    
    with open(package_json) as f:
        data = json.load(f)
    
    scripts = data.get("scripts", {})
    
    # Check for common development scripts
    useful_scripts = ["dev", "build", "start"]
    for script in useful_scripts:
        if script not in scripts:
            print(f"Recommended script '{script}' not found")
            return False
    
    return True

def check_typescript_support():
    """Check if TypeScript is properly configured."""
    tsconfig = Path("tsconfig.json")
    if not tsconfig.exists():
        # TypeScript is optional, not a failure
        return True
    
    try:
        with open(tsconfig) as f:
            json.load(f)
        return True
    except:
        print("Invalid tsconfig.json")
        return False

def test_node_modules():
    """Test that node_modules is properly installed."""
    node_modules = Path("node_modules")
    if not node_modules.exists():
        print("node_modules directory not found")
        return False
    
    onchainkit_dir = node_modules / "@coinbase" / "onchainkit"
    if not onchainkit_dir.exists():
        print("OnchainKit module not found in node_modules")
        return False
    
    return True

def run_build_test():
    """Test if the project can build successfully."""
    try:
        # Only test build if it's a Next.js project
        package_json = Path("package.json")
        with open(package_json) as f:
            data = json.load(f)
        
        scripts = data.get("scripts", {})
        if "build" not in scripts:
            return True  # Skip if no build script
        
        print("Running build test (this may take a moment)...")
        result = subprocess.run(["npm", "run", "build"], 
                              capture_output=True, text=True, 
                              timeout=60)  # 60 second timeout
        
        if result.returncode == 0:
            return True
        else:
            print(f"Build failed: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print("Build test timed out")
        return False
    except Exception as e:
        print(f"Build test error: {e}")
        return False

def print_summary(results):
    """Print a summary of validation results."""
    passed = sum(results.values())
    total = len(results)
    
    print(f"\n📊 Validation Summary: {passed}/{total} checks passed")
    
    if passed == total:
        print("""
🎉 All checks passed! Your OnchainKit setup is ready for development.

Quick start:
  npm run dev

Start building with OnchainKit:
  import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
""")
    else:
        print("\n❌ Some checks failed. Issues found:")
        for check_name, passed in results.items():
            if not passed:
                print(f"  - {check_name}")
        
        print("""
🔧 Common fixes:
  - Run: npm install
  - Copy .env.local.example to .env.local and add your API keys
  - Get API keys from:
    • CDP API: https://portal.cdp.coinbase.com/
    • WalletConnect: https://cloud.walletconnect.com/

Need help? Check the OnchainKit docs at https://onchainkit.xyz
""")

def main():
    print("🔍 Validating OnchainKit setup...\n")
    
    # Define all checks
    checks = [
        ("Project structure", check_project_structure),
        ("OnchainKit installed", check_onchainkit_installed),
        ("Required dependencies", check_required_dependencies),
        ("Environment file", check_env_file),
        ("API keys configured", check_api_keys),
        ("NPM scripts", check_npm_scripts),
        ("TypeScript config", check_typescript_support),
        ("Node modules", test_node_modules),
    ]
    
    # Run all checks
    results = {}
    for check_name, check_func in checks:
        results[check_name] = check_with_status(check_name, check_func)
    
    # Optional build test (more intensive)
    if "--skip-build" not in sys.argv:
        results["Build test"] = check_with_status("Build test", run_build_test)
    else:
        print("🔍 Build test... ⏭️  (skipped)")
    
    # Print summary
    print_summary(results)
    
    # Exit with error code if any checks failed
    if not all(results.values()):
        sys.exit(1)

if __name__ == "__main__":
    main()