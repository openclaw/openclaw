import { Di as MemoryEmbeddingProvider, ki as MemoryEmbeddingProviderCreateOptions } from "../../types-D1CySu2x.js";
//#region extensions/amazon-bedrock/embedding-provider.d.ts
type BedrockEmbeddingClient = {
  region: string;
  model: string;
  dimensions?: number;
};
declare const DEFAULT_BEDROCK_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
interface AwsCredentialProviderSdk {
  defaultProvider: (init?: {
    timeout?: number;
    maxRetries?: number;
  }) => () => Promise<{
    accessKeyId?: string;
  }>;
}
type AwsCredentialProviderLoader = () => Promise<AwsCredentialProviderSdk | null>;
declare function createBedrockEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<{
  provider: MemoryEmbeddingProvider;
  client: BedrockEmbeddingClient;
}>;
declare function hasAwsCredentials(env?: NodeJS.ProcessEnv, loadCredentialProvider?: AwsCredentialProviderLoader): Promise<boolean>;
//#endregion
export { DEFAULT_BEDROCK_EMBEDDING_MODEL, createBedrockEmbeddingProvider, hasAwsCredentials };