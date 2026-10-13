import {
  captureSecretRedactionRegistrySnapshot,
  redactRegisteredSecretValues,
} from "../../src/logging/secret-redaction-registry.ts";

export function createStreamSecretRedactor(mask: (value: string, index: number) => string) {
  const { values } = captureSecretRedactionRegistrySnapshot();
  let buffer = "";
  return {
    push(chunk: string): string {
      buffer += chunk;
      let hold = 0;
      for (const value of values) {
        for (let length = Math.min(value.length - 1, buffer.length); length > hold; length--) {
          if (buffer.endsWith(value.slice(0, length))) {
            hold = length;
            break;
          }
        }
      }
      let cut = buffer.length - hold;
      const spans: { index: number; value: string }[] = [];
      redactRegisteredSecretValues(buffer, (value, index) => {
        spans.push({ index, value });
        return value;
      });
      for (const { index, value } of spans) {
        if (index < cut && index + value.length > cut) {
          cut = index;
        }
      }
      const output = redactRegisteredSecretValues(buffer.slice(0, cut), mask);
      // Held-back characters are only a possible secret prefix; they appear with the next output or at exit.
      buffer = buffer.slice(cut);
      return output;
    },
    end(): string {
      const output = redactRegisteredSecretValues(buffer, mask);
      buffer = "";
      return output;
    },
  };
}
