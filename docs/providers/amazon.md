---
summary: "Use Amazon AWS services (Polly TTS, Transcribe STT, Nova Sonic voice) in OpenClaw"
read_when:
  - You want Amazon Polly text-to-speech
  - You want Amazon Transcribe speech-to-text
  - You want Nova Sonic realtime voice conversations
  - You already have AWS credentials configured
title: "Amazon"
---

Unified Amazon plugin providing **Polly TTS**, **Transcribe STT**, and **Nova Sonic realtime voice**.

All services authenticate via the [standard AWS IAM credential chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html) — no separate API key required.

## Setup

1. Ensure AWS credentials are available (instance role, SSO, `~/.aws/credentials`, or environment variables).
2. Enable in your OpenClaw config:

```yaml
plugins:
  entries:
    amazon:
      enabled: true
      config:
        polly:
          enabled: true
          voice: Ruth
          engine: generative
        transcribe:
          enabled: true
        novaSonic:
          enabled: true
          voice: tiffany
```

## Services

### Polly (Text-to-Speech)

| Key            | Default      | Description                                                                            |
| -------------- | ------------ | -------------------------------------------------------------------------------------- |
| `enabled`      | `true`       | Enable/disable Polly TTS                                                               |
| `voice`        | `Ruth`       | Voice ID (see [full list](https://docs.aws.amazon.com/polly/latest/dg/voicelist.html)) |
| `engine`       | `generative` | Engine: generative, neural, standard, long-form                                        |
| `region`       | `us-east-1`  | AWS region                                                                             |
| `languageCode` | `en-US`      | BCP-47 language code                                                                   |
| `sampleRate`   | `24000`      | Output sample rate (8000/16000/22050/24000)                                            |

### Transcribe (Speech-to-Text)

| Key            | Default     | Description                    |
| -------------- | ----------- | ------------------------------ |
| `enabled`      | `true`      | Enable/disable Transcribe STT  |
| `region`       | `us-east-1` | AWS region                     |
| `languageCode` | `en-US`     | Default transcription language |

### Nova Sonic (Realtime Voice)

| Key           | Default                  | Description                                                       |
| ------------- | ------------------------ | ----------------------------------------------------------------- |
| `enabled`     | `true`                   | Enable/disable Nova Sonic                                         |
| `region`      | `us-east-1`              | AWS region                                                        |
| `model`       | `amazon.nova-sonic-v1:0` | Model ID (`amazon.nova-sonic-v1:0` or `amazon.nova-2-sonic-v1:0`) |
| `voice`       | `tiffany`                | Voice ID (tiffany, matthew, amy)                                  |
| `temperature` | `0.7`                    | Generation temperature                                            |
| `maxTokens`   | `4096`                   | Max output tokens                                                 |

## Authentication

The plugin uses the AWS SDK default credential chain:

1. Environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)
2. Shared credentials file (`~/.aws/credentials`)
3. SSO credentials (`aws sso login`)
4. EC2 instance metadata (IAM role)
5. ECS task role
6. IMDSv2 instance profile

No additional configuration needed if credentials are already available for other AWS services (e.g., Bedrock).

## Audio Pipeline

The Nova Sonic bridge handles sample rate conversion automatically:

- **Input**: OpenClaw telephony mu-law (8kHz) → upsample to PCM 16kHz → Nova Sonic
- **Output**: Nova Sonic PCM 24kHz → downsample to 8kHz → mu-law → OpenClaw telephony

When using browser Talk (PCM 24kHz), the bridge passes audio through without resampling.

## Regional Availability

| Service    | Regions                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| Polly      | Most AWS regions (generative engine: us-east-1, eu-west-1 only)                  |
| Transcribe | us-east-1, us-east-2, us-west-2, eu-west-1, eu-central-1, ap-southeast-2, + more |
| Nova Sonic | us-east-1 (expanding)                                                            |
