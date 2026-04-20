from setuptools import setup, find_packages

setup(
    name="openclaw-guard",
    version="0.2.0",
    description="RBAC proxy for OpenClaw — multi-user permission management with WebSocket support",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    packages=find_packages(exclude=["tests"]),
    install_requires=["pyyaml>=6.0"],
    entry_points={"console_scripts": ["openclaw-guard=openclaw_guard.cli:main"]},
    python_requires=">=3.8",
)
