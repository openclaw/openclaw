(function attachCommentModel(global) {
  "use strict";

  const REQUIRED = {
    sheet: ["pageKey", "pageVersion", "sheetKey", "anchorType"],
    section: ["pageKey", "pageVersion", "sheetKey", "sectionKey", "anchorType"],
    row: ["pageKey", "pageVersion", "sheetKey", "sectionKey", "rowKey", "anchorType"],
    cell: ["pageKey", "pageVersion", "sheetKey", "sectionKey", "rowKey", "columnKey", "anchorType"]
  };

  function cleanPart(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^\w\u4e00-\u9fff.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }

  function normalizeAnchor(anchor) {
    anchor = anchor || {};
    return {
      pageKey: cleanPart(anchor.pageKey),
      pageVersion: cleanPart(anchor.pageVersion),
      sheetKey: cleanPart(anchor.sheetKey),
      sheetTitle: String(anchor.sheetTitle || "").trim(),
      sectionKey: cleanPart(anchor.sectionKey),
      sectionTitle: String(anchor.sectionTitle || "").trim(),
      rowKey: cleanPart(anchor.rowKey),
      rowLabel: String(anchor.rowLabel || "").trim(),
      columnKey: cleanPart(anchor.columnKey),
      columnLabel: String(anchor.columnLabel || "").trim(),
      anchorType: cleanPart(anchor.anchorType)
    };
  }

  function isValidAnchor(anchor) {
    const normalized = normalizeAnchor(anchor || {});
    const required = REQUIRED[normalized.anchorType];
    if (!required) return false;
    return required.every((key) => Boolean(normalized[key]));
  }

  function anchorId(anchor) {
    const normalized = normalizeAnchor(anchor);
    const parts = [
      normalized.pageKey,
      normalized.pageVersion,
      normalized.sheetKey,
      normalized.sectionKey || "_",
      normalized.rowKey || "_",
      normalized.columnKey || "_",
      normalized.anchorType
    ];
    return parts.join(":");
  }

  function anchorLabel(anchor) {
    const normalized = normalizeAnchor(anchor);
    const labels = [
      normalized.sheetTitle || normalized.sheetKey,
      normalized.sectionTitle || normalized.sectionKey,
      normalized.rowLabel || normalized.rowKey,
      normalized.columnLabel || normalized.columnKey
    ].filter(Boolean);
    return labels.join(" / ");
  }

  function makeMentionToken(anchor) {
    const normalized = normalizeAnchor(anchor);
    const label = anchorLabel(normalized);
    const tokenLabel = /[\n\r|}%]/.test(label) ? encodeURIComponent(label) : label;
    return `@{${normalized.anchorType}:${anchorId(normalized)}|${tokenLabel}}`;
  }

  function parseMentionToken(token) {
    const match = String(token || "").match(/^@\{(sheet|section|row|cell):([^|]+)\|([^}]*)\}$/);
    if (!match) return null;
    const parsed = global.constructor && global.constructor.name === "Object"
      ? new global.constructor()
      : {};
    parsed.id = match[2];
    try {
      parsed.label = decodeURIComponent(match[3]);
    } catch (_error) {
      parsed.label = match[3];
    }
    return parsed;
  }

  function readAnchorFromElement(element) {
    if (!element || !element.dataset) return null;
    const anchor = {
      pageKey: element.dataset.anchorPage,
      pageVersion: element.dataset.anchorVersion,
      sheetKey: element.dataset.anchorSheet,
      sheetTitle: element.dataset.anchorSheetTitle,
      sectionKey: element.dataset.anchorSection,
      sectionTitle: element.dataset.anchorSectionTitle,
      rowKey: element.dataset.anchorRow,
      rowLabel: element.dataset.anchorRowLabel,
      columnKey: element.dataset.anchorColumn,
      columnLabel: element.dataset.anchorColumnLabel,
      anchorType: element.dataset.anchorType
    };
    return isValidAnchor(anchor) ? normalizeAnchor(anchor) : null;
  }

  global.DashboardCommentModel = {
    normalizeAnchor,
    isValidAnchor,
    anchorId,
    anchorLabel,
    makeMentionToken,
    parseMentionToken,
    readAnchorFromElement
  };
})(typeof window !== "undefined" ? window : globalThis);
