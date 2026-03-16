# This workflow will trigger Datadog Synthetic tests within your Datadog organisation
# For more information on running Synthetic tests within your GitHub workflows see: https://docs.datadoghq.com/synthetics/cicd_integrations/github_actions/

# This workflow uses actions that are not certified by GitHub.
# They are provided by a third-party and are governed by
# separate terms of service, privacy policy, and support
# documentation.

# To get started:

# 1. Add your Datadog API (DD_API_KEY) and Application Key (DD_APP_KEY) as secrets to your GitHub repository. For more information, see: https://docs.datadoghq.com/account_management/api-app-keys/.
# 2. Start using the action within your workflow

name: Run Datadog Synthetic tests

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v4

    # Run Synthetic tests within your GitHub workflow.
    # For additional configuration options visit the action within the marketplace: https://github.com/marketplace/actions/datadog-synthetics-ci
    - name: Run Datadog Synthetic tests
      uses: DataDog/synthetics-ci-github-action@87b505388a22005bb8013481e3f73a367b9a53eb # v1.4.0
      with:
        api_key: ${{secrets.DD_API_KEY}}
        app_key: ${{secrets.DD_APP_KEY}}
        test_search_query: 'tag:e2e-tests' #Modify this tag to suit your tagging strategy


