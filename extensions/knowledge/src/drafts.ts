import { Check } from "typebox/value";
import { Evidence } from "./model.js";
import {
  SavePage,
  ClaimInput,
  RelationshipInput,
  type WriteInput,
  type WriteKind,
} from "./mutation-contract.js";

export type EditorDraft = {
  version: 1;
  key: string;
  title: string;
  body: string;
  type: string;
  fields: string;
  source: string;
  attribution: string;
  base?: { id: string; revision: number; hash: string };
  kind?: WriteKind;
  values?: Record<string, string>;
  submitted?: WriteInput;
  attachments?: import("./model.js").Evidence[];
};
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Tab-local recovery, never a server save. Only open after an authorized status response. */
export class DraftStore {
  private readonly key: string;
  readonly vaultId: string;
  constructor(
    identity: { agent: string; vault: string; scope: string },
    private readonly storage: DraftStorage,
  ) {
    this.vaultId = identity.vault;
    this.key =
      "knowledge:draft:v1:" + JSON.stringify([identity.agent, identity.vault, identity.scope]);
  }
  read(): EditorDraft | undefined {
    const raw = this.storage.getItem(this.key);
    if (!raw) {
      return undefined;
    }
    if (raw.length > 400000) {
      throw new Error("Stored draft is too large; it was preserved but not opened.");
    }
    // SAFETY: every EditorDraft field is checked below before the value is returned; any other shape throws.
    const value = JSON.parse(raw) as EditorDraft;
    if (
      value.version !== 1 ||
      ![
        value.key,
        value.title,
        value.body,
        value.type,
        value.fields,
        value.source,
        value.attribution,
      ].every((v) => typeof v === "string") ||
      (value.base &&
        (typeof value.base.id !== "string" ||
          typeof value.base.hash !== "string" ||
          !Number.isInteger(value.base.revision))) ||
      (value.attachments &&
        (!Array.isArray(value.attachments) ||
          !value.attachments.every((e) => Check(Evidence, e)))) ||
      (value.kind && !["page", "claim", "relationship"].includes(value.kind)) ||
      (value.values &&
        (typeof value.values !== "object" ||
          Object.values(value.values).some((v) => typeof v !== "string"))) ||
      (value.submitted &&
        !Check(
          value.kind === "claim"
            ? ClaimInput
            : value.kind === "relationship"
              ? RelationshipInput
              : SavePage,
          value.submitted,
        ))
    ) {
      throw new Error("Stored draft is invalid; it was preserved but not opened.");
    }
    return value;
  }
  write(draft: EditorDraft) {
    const raw = JSON.stringify(draft);
    if (raw.length > 400000) {
      throw new Error(
        "Draft exceeds browser recovery storage limit. Copy your text before leaving.",
      );
    }
    this.storage.setItem(this.key, raw);
  }
  remove(key: string) {
    if (this.read()?.key === key) {
      this.storage.removeItem(this.key);
    }
  }
}
