/**
 * Shared facts for the Amazon Bedrock AWS SDK account.
 *
 * Bedrock has no secret to store: every request resolves through the AWS SDK
 * default credential chain. The account record therefore holds the host's
 * non-secret AWS SDK marker instead of a credential, which still gives
 * schedulers a real account whose lifetime they can bind and revoke.
 */
export const BEDROCK_PROVIDER_ID = "amazon-bedrock";
export const BEDROCK_AWS_SDK_PROFILE_ID = `${BEDROCK_PROVIDER_ID}:aws-sdk`;
export const BEDROCK_AWS_SDK_AUTH_METHOD_ID = "aws-sdk";
/** Mirrors the host's non-secret marker for AWS SDK chain credentials. */
export const AWS_SDK_CREDENTIALS_MARKER = "aws-sdk-credentials";
