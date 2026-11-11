import { DatabaseSync } from "node:sqlite";

export function hasTrigramTokenizerForTests(): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE tokenizer_probe USING fts5(text, tokenize='trigram')");
    return true;
  } catch (error) {
    // Only the optional tokenizer's absence permits skipping its cases. Production
    // schema or query failures must still fail both levels of Unicode regression.
    if (error instanceof Error && error.message.includes("no such tokenizer: trigram")) {
      return false;
    }
    throw error;
  } finally {
    db.close();
  }
}
