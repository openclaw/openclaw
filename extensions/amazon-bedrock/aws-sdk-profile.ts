/**
 * Shared facts for the Amazon Bedrock AWS SDK auth profile.
 *
 * Bedrock has no secret to store: every request resolves through the AWS SDK
 * default credential chain. The profile is therefore declared in config only
 * (`auth.profiles.<id>.mode: "aws-sdk"` next to `models.providers.<id>.auth:
 * "aws-sdk"`), which gives schedulers a durable account id to record while the
 * credential store keeps no AWS material.
 */
export const BEDROCK_PROVIDER_ID = "amazon-bedrock";
export const BEDROCK_AWS_SDK_PROFILE_ID = `${BEDROCK_PROVIDER_ID}:aws-sdk`;
export const BEDROCK_AWS_SDK_AUTH_METHOD_ID = "aws-sdk";
