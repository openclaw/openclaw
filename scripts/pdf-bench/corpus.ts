/**
 * Corpus loading, ground-truth association, filtering, and smoke-corpus generation.
 *
 * Supports:
 *   --manifest <path>   Load dataset-manifest.json
 *   --gt <path>         Load extraction_ground_truth.jsonl
 *   --corpus-dir <dir>  Base directory for manifest-relative PDF file paths
 *   --pdf <path>        Ad-hoc PDF (repeatable)
 *   --input-dir <dir>   Load all *.pdf from a directory
 *   --doc-id <id>       Filter by document ID (repeatable)
 *   --doc-type <type>   Filter by document type (repeatable)
 *   --limit <n>         Max documents to include
 *   --smoke             Generate synthetic PDFs with embedded GT
 */

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CorpusEntry,
  CorpusManifest,
  DocType,
  GroundTruth,
  GroundTruthRecord,
  ManifestEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

export function loadManifest(manifestPath: string, corpusDir: string): CorpusEntry[] {
  const raw = readFileSync(manifestPath, "utf8");
  const manifest: CorpusManifest = JSON.parse(raw);
  if (!Array.isArray(manifest.corpus)) {
    throw new Error(`Invalid manifest: expected .corpus array in ${manifestPath}`);
  }
  return manifest.corpus.map((entry: ManifestEntry) => {
    const filePath = path.resolve(corpusDir, entry.file);
    let bytes: number | undefined;
    try {
      bytes = statSync(filePath).size;
    } catch {
      // file might not exist yet; will fail at read time
    }
    return {
      id: entry.id,
      label: entry.label ?? path.basename(entry.file),
      filePath,
      docType: parseDocType(entry.docType),
      pageCount: entry.pageCount,
      bytes,
    };
  });
}

// ---------------------------------------------------------------------------
// Ground truth loading
// ---------------------------------------------------------------------------

export function loadGroundTruth(gtPath: string): Map<string, GroundTruth> {
  const raw = readFileSync(gtPath, "utf8");
  const map = new Map<string, GroundTruth>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const record: GroundTruthRecord = JSON.parse(trimmed);
    map.set(record.doc_id, {
      textFields: record.text_fields,
      keyValues: record.key_values,
      tables: record.tables,
      expectedSnippets: record.expected_snippets,
    });
  }
  return map;
}

export function associateGroundTruth(
  entries: CorpusEntry[],
  gt: Map<string, GroundTruth>,
): CorpusEntry[] {
  return entries.map((entry) => ({
    ...entry,
    groundTruth: gt.get(entry.id) ?? entry.groundTruth,
  }));
}

// ---------------------------------------------------------------------------
// Ad-hoc corpus loading
// ---------------------------------------------------------------------------

export function loadAdHocPdfs(pdfPaths: string[]): CorpusEntry[] {
  return pdfPaths.map((p, i) => {
    const resolved = path.resolve(p);
    let bytes: number | undefined;
    try {
      bytes = statSync(resolved).size;
    } catch {
      // will fail at read time
    }
    return {
      id: `adhoc-${i + 1}`,
      label: path.basename(resolved),
      filePath: resolved,
      bytes,
    };
  });
}

export function loadInputDir(dir: string): CorpusEntry[] {
  const resolved = path.resolve(dir);
  const files = readdirSync(resolved)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .toSorted();
  return files.map((name, i) => {
    const filePath = path.join(resolved, name);
    let bytes: number | undefined;
    try {
      bytes = statSync(filePath).size;
    } catch {
      // ignore
    }
    return {
      id: `dir-${i + 1}`,
      label: name,
      filePath,
      bytes,
    };
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function filterCorpus(
  entries: CorpusEntry[],
  filters: { docIds?: string[]; docTypes?: string[]; limit?: number },
): CorpusEntry[] {
  let filtered = entries;
  if (filters.docIds && filters.docIds.length > 0) {
    const ids = new Set(filters.docIds);
    filtered = filtered.filter((e) => ids.has(e.id));
  }
  if (filters.docTypes && filters.docTypes.length > 0) {
    const types = new Set(filters.docTypes);
    filtered = filtered.filter((e) => e.docType && types.has(e.docType));
  }
  if (filters.limit && filters.limit > 0) {
    filtered = filtered.slice(0, filters.limit);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Buffer loading
// ---------------------------------------------------------------------------

export function ensureBuffers(entries: CorpusEntry[]): CorpusEntry[] {
  return entries.map((entry) => {
    if (entry.buffer) {
      return entry;
    }
    const buffer = readFileSync(entry.filePath);
    return { ...entry, buffer, bytes: buffer.length };
  });
}

// ---------------------------------------------------------------------------
// Smoke corpus (synthetic PDFs with embedded GT)
// ---------------------------------------------------------------------------

function sanitizePdfText(text: string): string {
  return text.replace(/[()\\]/g, " ");
}

function createPdfBuffer(lines: string[]): Buffer {
  const content = [
    "BT /F1 12 Tf 72 720 Td",
    ...lines.map((line, i) => {
      const escaped = sanitizePdfText(line);
      return i === 0 ? `(${escaped}) Tj` : `0 -18 Td (${escaped}) Tj`;
    }),
    "ET",
  ].join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(content, "utf8")} >> stream\n${content}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

type SmokeSpec = {
  id: string;
  label: string;
  fileName: string;
  docType: DocType;
  lines: string[];
  groundTruth: GroundTruth;
};

const SMOKE_SPECS: SmokeSpec[] = [
  {
    id: "smoke-invoice",
    label: "smoke invoice",
    fileName: "smoke-invoice.pdf",
    docType: "invoice",
    lines: [
      "INVOICE",
      "Invoice Number INV-2024-0042",
      "Date 2024-03-15",
      "Vendor Acme Corporation",
      "Bill To Widget Labs Inc",
      "Item Quantity Unit Price Total",
      "Premium Widget 10 24.99 249.90",
      "Standard Gadget 5 12.50 62.50",
      "Subtotal 312.40",
      "Tax 8.5 pct 26.55",
      "Total Due 338.95",
      "Payment Terms Net 30",
    ],
    groundTruth: {
      textFields: {
        invoiceNumber: "INV-2024-0042",
        date: "2024-03-15",
        vendor: "Acme Corporation",
        billTo: "Widget Labs Inc",
      },
      keyValues: {
        subtotal: "312.40",
        tax: "26.55",
        totalDue: "338.95",
        paymentTerms: "Net 30",
      },
      tables: [
        {
          label: "line items",
          headers: ["Item", "Quantity", "Unit Price", "Total"],
          rows: [
            ["Premium Widget", "10", "24.99", "249.90"],
            ["Standard Gadget", "5", "12.50", "62.50"],
          ],
        },
      ],
      expectedSnippets: [
        "INVOICE",
        "INV-2024-0042",
        "Acme Corporation",
        "338.95",
        "Premium Widget",
      ],
    },
  },
  {
    id: "smoke-contract",
    label: "smoke contract",
    fileName: "smoke-contract.pdf",
    docType: "contract",
    lines: [
      "SERVICE AGREEMENT",
      "This Agreement is entered into as of January 1 2024",
      "Between Provider TechServices LLC",
      "And Client GlobalRetail Inc",
      "Term This agreement shall remain in effect for 24 months",
      "Monthly Fee 4500.00 USD",
      "Payment Due within 15 business days of invoice date",
      "Termination Either party may terminate with 60 days written notice",
      "Governing Law State of Delaware",
      "This text adds enough characters to keep the paragraph above the pdfjs text threshold for extraction.",
    ],
    groundTruth: {
      textFields: {
        agreementType: "SERVICE AGREEMENT",
        effectiveDate: "January 1 2024",
        provider: "TechServices LLC",
        client: "GlobalRetail Inc",
      },
      keyValues: {
        term: "24 months",
        monthlyFee: "4500.00",
        paymentDue: "15 business days",
        terminationNotice: "60 days",
        governingLaw: "State of Delaware",
      },
      expectedSnippets: [
        "SERVICE AGREEMENT",
        "TechServices LLC",
        "GlobalRetail Inc",
        "24 months",
        "4500.00",
      ],
    },
  },
  {
    id: "smoke-report",
    label: "smoke quarterly report",
    fileName: "smoke-report.pdf",
    docType: "report",
    lines: [
      "Q3 2024 Performance Report",
      "Executive Summary",
      "Revenue grew 18 percent year over year driven by enterprise expansion.",
      "Gross margin improved to 72 percent from 68 percent in the prior quarter.",
      "Quarterly Metrics",
      "Quarter Revenue Margin Customers",
      "Q1 12.4M 65 pct 1240",
      "Q2 14.1M 68 pct 1385",
      "Q3 16.6M 72 pct 1520",
      "Key Highlights",
      "Enterprise ARR reached 45M representing 42 percent of total revenue.",
      "Net retention rate improved to 118 percent.",
      "Customer acquisition cost decreased 12 percent quarter over quarter.",
    ],
    groundTruth: {
      textFields: {
        reportTitle: "Q3 2024 Performance Report",
        revenueGrowth: "18 percent",
        grossMargin: "72 percent",
      },
      keyValues: {
        enterpriseARR: "45M",
        netRetention: "118 percent",
        cacChange: "12 percent",
      },
      tables: [
        {
          label: "quarterly metrics",
          headers: ["Quarter", "Revenue", "Margin", "Customers"],
          rows: [
            ["Q1", "12.4M", "65", "1240"],
            ["Q2", "14.1M", "68", "1385"],
            ["Q3", "16.6M", "72", "1520"],
          ],
        },
      ],
      expectedSnippets: [
        "Q3 2024 Performance Report",
        "18 percent year over year",
        "Enterprise ARR",
        "118 percent",
      ],
    },
  },
  {
    id: "smoke-form",
    label: "smoke application form",
    fileName: "smoke-form.pdf",
    docType: "form",
    lines: [
      "APPLICATION FORM",
      "Section 1 Personal Information",
      "Full Name Jane A Doe",
      "Date of Birth 1990-05-22",
      "Email jane.doe at example.com",
      "Phone 555-0142",
      "Section 2 Employment",
      "Current Employer Widgets International",
      "Position Senior Engineer",
      "Years of Experience 8",
      "Section 3 Education",
      "Degree Master of Science Computer Science",
      "University State Technical University",
      "Graduation Year 2014",
      "This additional text ensures the form content exceeds the minimum character threshold for text extraction mode.",
    ],
    groundTruth: {
      textFields: {
        formTitle: "APPLICATION FORM",
        fullName: "Jane A Doe",
        dateOfBirth: "1990-05-22",
        email: "jane.doe at example.com",
        phone: "555-0142",
      },
      keyValues: {
        employer: "Widgets International",
        position: "Senior Engineer",
        experience: "8",
        degree: "Master of Science Computer Science",
        university: "State Technical University",
        graduationYear: "2014",
      },
      expectedSnippets: [
        "APPLICATION FORM",
        "Jane A Doe",
        "Widgets International",
        "Senior Engineer",
        "State Technical University",
      ],
    },
  },
  {
    id: "smoke-tabular",
    label: "smoke pricing table",
    fileName: "smoke-tabular.pdf",
    docType: "tabular",
    lines: [
      "Product Pricing Schedule 2024",
      "Effective Date April 1 2024",
      "SKU Product Name Category Unit Price Min Order",
      "SKU-001 Alpha Widget Hardware 29.99 100",
      "SKU-002 Beta Sensor Electronics 74.50 50",
      "SKU-003 Gamma Module Software 199.00 10",
      "SKU-004 Delta Cable Accessories 8.75 500",
      "SKU-005 Epsilon Board Electronics 142.00 25",
      "Notes All prices in USD. Volume discounts available for orders above 1000 units.",
      "Contact sales at example.com for custom quotes.",
    ],
    groundTruth: {
      textFields: {
        title: "Product Pricing Schedule 2024",
        effectiveDate: "April 1 2024",
      },
      tables: [
        {
          label: "pricing",
          headers: ["SKU", "Product Name", "Category", "Unit Price", "Min Order"],
          rows: [
            ["SKU-001", "Alpha Widget", "Hardware", "29.99", "100"],
            ["SKU-002", "Beta Sensor", "Electronics", "74.50", "50"],
            ["SKU-003", "Gamma Module", "Software", "199.00", "10"],
            ["SKU-004", "Delta Cable", "Accessories", "8.75", "500"],
            ["SKU-005", "Epsilon Board", "Electronics", "142.00", "25"],
          ],
        },
      ],
      expectedSnippets: [
        "Product Pricing Schedule",
        "SKU-001",
        "Alpha Widget",
        "Epsilon Board",
        "Volume discounts",
      ],
    },
  },
];

export type SmokeCorpus = {
  entries: CorpusEntry[];
  tmpDir: string;
};

export function createSmokeCorpus(): SmokeCorpus {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pdf-bench3-"));
  const entries: CorpusEntry[] = SMOKE_SPECS.map((spec) => {
    const filePath = path.join(tmpDir, spec.fileName);
    const buffer = createPdfBuffer(spec.lines);
    writeFileSync(filePath, buffer);
    return {
      id: spec.id,
      label: spec.label,
      filePath,
      docType: spec.docType,
      pageCount: 1,
      bytes: buffer.length,
      groundTruth: spec.groundTruth,
      buffer,
    };
  });
  return { entries, tmpDir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_DOC_TYPES = new Set<DocType>([
  "form",
  "invoice",
  "contract",
  "report",
  "tabular",
  "ocr-scanned",
  "mixed-layout",
  "other",
]);

function parseDocType(raw?: string): DocType | undefined {
  if (!raw) {
    return undefined;
  }
  const lower = raw.trim().toLowerCase() as DocType;
  return VALID_DOC_TYPES.has(lower) ? lower : "other";
}

// ---------------------------------------------------------------------------
// Full corpus resolution (combines all sources)
// ---------------------------------------------------------------------------

export type CorpusOptions = {
  manifestPath?: string;
  gtPath?: string;
  corpusDir?: string;
  pdfPaths?: string[];
  inputDir?: string;
  smoke?: boolean;
  docIds?: string[];
  docTypes?: string[];
  limit?: number;
};

export type ResolvedCorpus = {
  entries: CorpusEntry[];
  /** Set if smoke corpus was created (caller should clean up). */
  smokeTmpDir?: string;
};

export function resolveCorpus(options: CorpusOptions): ResolvedCorpus {
  const all: CorpusEntry[] = [];
  let smokeTmpDir: string | undefined;

  // Manifest-based corpus
  if (options.manifestPath) {
    const dir = options.corpusDir ?? path.dirname(options.manifestPath);
    const manifestEntries = loadManifest(options.manifestPath, dir);
    all.push(...manifestEntries);
  }

  // Ad-hoc PDFs
  if (options.pdfPaths && options.pdfPaths.length > 0) {
    all.push(...loadAdHocPdfs(options.pdfPaths));
  }

  // Input directory
  if (options.inputDir) {
    all.push(...loadInputDir(options.inputDir));
  }

  // Smoke corpus
  if (options.smoke) {
    const smoke = createSmokeCorpus();
    smokeTmpDir = smoke.tmpDir;
    all.push(...smoke.entries);
  }

  // Associate ground truth
  let entries = all;
  if (options.gtPath) {
    const gt = loadGroundTruth(options.gtPath);
    entries = associateGroundTruth(entries, gt);
  }

  // Filter
  entries = filterCorpus(entries, {
    docIds: options.docIds,
    docTypes: options.docTypes,
    limit: options.limit,
  });

  if (entries.length === 0) {
    throw new Error("Empty corpus. Provide --manifest, --pdf, --input-dir, or --smoke.");
  }

  // Load buffers
  entries = ensureBuffers(entries);

  return { entries, smokeTmpDir };
}
