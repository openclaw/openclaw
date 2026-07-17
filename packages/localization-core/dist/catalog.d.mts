import { OpenClawLocale } from "./locale-registry.mjs";
import { LocalizationContext } from "./context.mjs";

//#region src/catalog.d.ts
type MessageParam = string | number | boolean;
type LocalizedMessage = {
  key: string;
  params?: Readonly<Record<string, MessageParam>>;
  fallback: string;
};
type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
type CatalogMessage = string | {
  kind: "plural";
  param: string;
  cases: Partial<Record<PluralCategory, string>> & {
    other: string;
  };
} | {
  kind: "select";
  param: string;
  cases: Readonly<Record<string, string>> & {
    other: string;
  };
};
type LocalizationCatalog = Readonly<Record<string, CatalogMessage>>;
type CatalogSnapshot = {
  registryRevision: string;
  catalogRevision: string;
  catalogs: Readonly<Partial<Record<OpenClawLocale, LocalizationCatalog>>>;
};
type CatalogValidationIssue = {
  code: "invalid-key" | "missing-key" | "unknown-key" | "placeholder-mismatch" | "invalid-selector" | "forbidden-bidi-control";
  key: string;
  detail: string;
};
declare function createCatalogSnapshot(params: {
  catalogRevision: string;
  catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>;
  registryRevision?: string;
}): CatalogSnapshot;
declare function renderLocalizedMessage(snapshot: CatalogSnapshot, context: LocalizationContext, message: LocalizedMessage): string;
declare function interpolateMessage(value: string, params?: Readonly<Record<string, MessageParam>>): string;
declare function validateCatalog(params: {
  namespace: string;
  source: LocalizationCatalog;
  candidate: LocalizationCatalog;
}): readonly CatalogValidationIssue[];
//#endregion
export { CatalogMessage, CatalogSnapshot, CatalogValidationIssue, LocalizationCatalog, LocalizedMessage, MessageParam, PluralCategory, createCatalogSnapshot, interpolateMessage, renderLocalizedMessage, validateCatalog };