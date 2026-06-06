---
summary: "Amazon AWS AI services — Polly TTS, Transcribe STT, Nova Sonic realtime voice"
read_when:
  - You want Amazon Polly text-to-speech
  - You want Amazon Transcribe speech-to-text
  - You want Amazon Nova Sonic realtime voice conversations
  - You need AWS credential configuration for AI providers
title: "Amazon"
---

The **Amazon** plugin bundles three AWS AI services into a single extension:

| Service           | Capability     | Default Model / Voice               |
| ----------------- | -------------- | ----------------------------------- |
| Amazon Polly      | TTS (speech)   | `generative` engine, `Ruth`         |
| Amazon Transcribe | STT (audio)    | Streaming transcription             |
| Nova Sonic        | Realtime voice | `amazon.nova-sonic-v1:0`, `tiffany` |

All services authenticate via the **AWS IAM credential chain** (environment
variables, shared credentials file, instance profile, ECS task role, etc.).
No separate API key is needed — if your environment can call AWS APIs, the
plugin will work.

| Detail  | Value                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| Website | [aws.amazon.com](https://aws.amazon.com)                                                  |
| Docs    | [docs.aws.amazon.com](https://docs.aws.amazon.com)                                        |
| Auth    | AWS IAM credential chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or instance role) |
| Regions | Any AWS region where the services are available                                           |

## Getting started

<Steps>
  <Step title="Ensure AWS credentials are available">
    The plugin uses the standard AWS SDK credential chain. Set environment
    variables or configure `~/.aws/credentials`:

    ```bash
    export AWS_ACCESS_KEY_ID=AKIA...
    export AWS_SECRET_ACCESS_KEY=...
    export AWS_REGION=us-east-1
    ```

  </Step>
  <Step title="Enable the plugin">
    ```json5
    {
      "plugins": {
        "entries": {
          "amazon": {
            "enabled": true,
            "config": {
              "polly": {
                "enabled": true,
                "region": "us-east-1",
                "voice": "Ruth",
                "engine": "generative"
              },
              "transcribe": {
                "enabled": true,
                "region": "us-east-1",
                "languageCode": "en-US"
              },
              "novaSonic": {
                "enabled": true,
                "region": "us-east-1",
                "voice": "tiffany"
              }
            }
          }
        }
      }
    }
    ```

  </Step>
</Steps>

## Configuration reference

### Polly (TTS)

| Key       | Default      | Description                           |
| --------- | ------------ | ------------------------------------- |
| `enabled` | `true`       | Enable/disable Polly TTS              |
| `region`  | `us-east-1`  | AWS region                            |
| `voice`   | `Ruth`       | Polly voice ID                        |
| `engine`  | `generative` | `generative`, `neural`, or `standard` |

### Transcribe (STT)

| Key            | Default     | Description                     |
| -------------- | ----------- | ------------------------------- |
| `enabled`      | `true`      | Enable/disable Transcribe STT   |
| `region`       | `us-east-1` | AWS region                      |
| `languageCode` | —           | BCP-47 language code (optional) |

### Nova Sonic (Realtime Voice)

| Key           | Default                  | Description                                                                                                                           |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | `true`                   | Enable/disable Nova Sonic                                                                                                             |
| `region`      | `us-east-1`              | AWS region                                                                                                                            |
| `model`       | `amazon.nova-sonic-v1:0` | Model ID (`amazon.nova-sonic-v1:0` or `amazon.nova-2-sonic-v1:0`)                                                                     |
| `voice`       | `tiffany`                | Voice ID (tiffany, matthew, amy, olivia, lupe, carlos, ambre, florian, lennart, beatrice, lorenzo, tina, carolina, leo, kiara, arjun) |
| `temperature` | `0.7`                    | Generation temperature                                                                                                                |
| `maxTokens`   | `4096`                   | Max output tokens                                                                                                                     |

## Disabling individual services

Set `enabled: false` on any sub-service to skip registration:

```json5
{
  plugins: {
    entries: {
      amazon: {
        config: {
          transcribe: { enabled: false },
        },
      },
    },
  },
}
```
