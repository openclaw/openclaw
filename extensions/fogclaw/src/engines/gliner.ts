import type { Entity } from "../types.js";
import { canonicalType } from "../types.js";

const DEFAULT_NER_LABELS = [
  "person",
  "organization",
  "location",
  "address",
  "date of birth",
  "medical record number",
  "account number",
  "passport number",
];

export class GlinerEngine {
  private model: any = null;
  private modelPath: string;
  private threshold: number;
  private customLabels: string[] = [];
  private initialized = false;

  constructor(modelPath: string, threshold: number = 0.5) {
    this.modelPath = modelPath;
    this.threshold = threshold;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { Gliner } = await import("gliner");
      this.model = new Gliner({
        tokenizerPath: this.modelPath,
        onnxSettings: {
          modelPath: this.modelPath,
          executionProvider: "cpu",
        },
        maxWidth: 12,
        modelType: "gliner",
      });
      await this.model.initialize();
      this.initialized = true;
    } catch (err) {
      throw new Error(
        `Failed to initialize GLiNER model "${this.modelPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  setCustomLabels(labels: string[]): void {
    this.customLabels = labels;
  }

  async scan(text: string, extraLabels?: string[]): Promise<Entity[]> {
    if (!text) return [];
    if (!this.model) {
      throw new Error("GLiNER engine not initialized. Call initialize() first.");
    }

    const labels = [
      ...DEFAULT_NER_LABELS,
      ...this.customLabels,
      ...(extraLabels ?? []),
    ];

    // Deduplicate labels
    const uniqueLabels = [...new Set(labels)];

    const results = await this.model.inference(text, uniqueLabels, {
      threshold: this.threshold,
    });

    return results.map(
      (r: { text: string; label: string; score: number; start: number; end: number }) => ({
        text: r.text,
        label: canonicalType(r.label),
        start: r.start,
        end: r.end,
        confidence: r.score,
        source: "gliner" as const,
      }),
    );
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}
