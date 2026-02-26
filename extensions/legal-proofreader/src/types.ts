export type IssueCategory =
  | "MISTRANSLATION"
  | "OMISSION"
  | "ADDITION"
  | "TERMINOLOGY"
  | "GRAMMAR"
  | "CROSS_REF"
  | "FORMATTING";

export type IssueSeverity = "HIGH" | "MEDIUM" | "LOW";

export type IssueRecord = {
  issueId: string;
  article: string;
  clause: string;
  category: IssueCategory;
  arabicExcerpt: string;
  englishExcerpt: string;
  correction: string;
  severity: IssueSeverity;
  notes: string;
  apply: boolean;
};

export type AlignedArticle = {
  articleId: string;
  arabicText: string;
  englishText: string;
  pageRef: string;
};

export type GlossaryEntry = {
  arabicTerm: string;
  englishTerm: string;
};

export type ProofreadingResult = {
  sessionId: string;
  issueCount: number;
  issuesByCategory: Record<IssueCategory, number>;
  issuesBySeverity: Record<IssueSeverity, number>;
  xlsxPath: string;
};

export type CorrectedDocumentResult = {
  correctedDocxPath: string;
  correctionsApplied: number;
  correctionsFailed: number;
  correctionSkipped: number;
  failures: Array<{ issueId: string; reason: string }>;
};
