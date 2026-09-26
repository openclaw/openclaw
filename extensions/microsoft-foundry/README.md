# Microsoft Foundry

Use model deployments in Microsoft Foundry from OpenClaw. The plugin supports
chat deployments and MAI image generation, with Microsoft Entra ID or API-key
authentication.

## Get started

Run `openclaw onboard` and choose **Microsoft Foundry**. Select Entra ID to use
the Azure CLI, or provide an Azure OpenAI API key and your resource endpoint.
The Entra ID path requires the Azure CLI on the OpenClaw host.

Choose a deployment from your resource. Model references use
`microsoft-foundry/<deployment-name>`; public model names alone do not identify
your deployments. Image generation needs a supported MAI deployment.

See the [Microsoft Foundry reference](https://docs.openclaw.ai/plugins/reference/microsoft-foundry)
for resource requirements and image limits.
