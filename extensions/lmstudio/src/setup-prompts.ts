import { toFetchableLmstudioBaseUrl } from "./models.js";

export type ProviderPromptText = (params: {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | undefined;
}) => Promise<string | undefined>;

export type ProviderPromptNote = (message: string, title?: string) => Promise<void> | void;

export function validateLmstudioSetupUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return "Required";
  }
  const invalidUrl = "Enter a valid HTTP or HTTPS URL (e.g. http://localhost:1234).";
  try {
    const parsed = new URL(toFetchableLmstudioBaseUrl(value.trim()));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? undefined : invalidUrl;
  } catch {
    return invalidUrl;
  }
}
