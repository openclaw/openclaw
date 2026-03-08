# File Utilities

## Principle

Read and validate files (CSV, XLSX, PDF, ZIP) with automatic parsing, type-safe results, and download handling. Simplify file operations in Playwright tests with built-in format support and validation helpers.

## Rationale

Testing file operations in Playwright requires boilerplate:

- Manual download handling
- External parsing libraries for each format
- No validation helpers
- Type-unsafe results
- Repetitive path handling

The `file-utils` module provides:

- **Auto-parsing**: CSV, XLSX, PDF, ZIP automatically parsed
- **Download handling**: Single function for UI or API-triggered downloads
- **Type-safe**: TypeScript interfaces for parsed results
- **Validation helpers**: Row count, header checks, content validation
- **Format support**: Multiple sheet support (XLSX), text extraction (PDF), archive extraction (ZIP)

## Why Use This Instead of Vanilla Playwright?

| Vanilla Playwright                          | File Utils                                       |
| ------------------------------------------- | ------------------------------------------------ |
| ~80 lines per CSV flow (download + parse)   | ~10 lines end-to-end                             |
| Manual event orchestration for downloads    | Encapsulated in `handleDownload()`               |
| Manual path handling and `saveAs`           | Returns a ready-to-use file path                 |
| Manual existence checks and error handling  | Centralized in one place via utility patterns    |
| Manual CSV parsing config (headers, typing) | `readCSV()` returns `{ data, headers }` directly |

## Pattern Examples

### Example 1: UI-Triggered CSV Download

**Context**: User clicks button, CSV downloads, validate contents.

**Implementation**:

```typescript
import { handleDownload, readCSV } from "@seontechnologies/playwright-utils/file-utils";
import path from "node:path";

const DOWNLOAD_DIR = path.join(__dirname, "../downloads");

test("should download and validate CSV", async ({ page }) => {
  const downloadPath = await handleDownload({
    page,
    downloadDir: DOWNLOAD_DIR,
    trigger: () => page.getByTestId("download-button-text/csv").click(),
  });

  const csvResult = await readCSV({ filePath: downloadPath });

  // Access parsed data and headers
  const { data, headers } = csvResult.content;
  expect(headers).toEqual(["ID", "Name", "Email"]);
  expect(data[0]).toMatchObject({
    ID: expect.any(String),
    Name: expect.any(String),
    Email: expect.any(String),
  });
});
```

**Key Points**:

- `handleDownload` waits for download, returns file path
- `readCSV` auto-parses to `{ headers, data }`
- Type-safe access to parsed content
- Clean up downloads in `afterEach`

### Example 2: XLSX with Multiple Sheets

**Context**: Excel file with multiple sheets (e.g., Summary, Details, Errors).

**Implementation**:

```typescript
import { readXLSX } from "@seontechnologies/playwright-utils/file-utils";

test("should read multi-sheet XLSX", async () => {
  const downloadPath = await handleDownload({
    page,
    downloadDir: DOWNLOAD_DIR,
    trigger: () => page.click('[data-testid="export-xlsx"]'),
  });

  const xlsxResult = await readXLSX({ filePath: downloadPath });

  // Verify worksheet structure
  expect(xlsxResult.content.worksheets.length).toBeGreaterThan(0);
  const worksheet = xlsxResult.content.worksheets[0];
  expect(worksheet).toBeDefined();
  expect(worksheet).toHaveProperty("name");

  // Access sheet data
  const sheetData = worksheet?.data;
  expect(Array.isArray(sheetData)).toBe(true);

  // Use type assertion for type safety
  const firstRow = sheetData![0] as Record<string, unknown>;
  expect(firstRow).toHaveProperty("id");
});
```

**Key Points**:

- `worksheets` array with `name` and `data` properties
- Access sheets by name
- Each sheet has its own headers and data
- Type-safe sheet iteration

### Example 3: PDF Text Extraction

**Context**: Validate PDF report contains expected content.

**Implementation**:

```typescript
import { readPDF } from "@seontechnologies/playwright-utils/file-utils";

test("should validate PDF report", async () => {
  const downloadPath = await handleDownload({
    page,
    downloadDir: DOWNLOAD_DIR,
    trigger: () => page.getByTestId("download-button-Text-based PDF Document").click(),
  });

  const pdfResult = await readPDF({ filePath: downloadPath });

  // content is extracted text from all pages
  expect(pdfResult.pagesCount).toBe(1);
  expect(pdfResult.fileName).toContain(".pdf");
  expect(pdfResult.content).toContain("All you need is the free Adobe Acrobat Reader");
});
```

**PDF Reader Options:**

```typescript
const result = await readPDF({
  filePath: "/path/to/document.pdf",
  mergePages: false, // Keep pages separate (default: true)
  debug: true, // Enable debug logging
  maxPages: 10, // Limit processing to first 10 pages
});
```

**Important Limitation - Vector-based PDFs:**

Text extraction may fail for PDFs that store text as vector graphics (e.g., those generated by jsPDF):

```typescript
// Vector-based PDF example (extraction fails gracefully)
const pdfResult = await readPDF({ filePath: downloadPath });

expect(pdfResult.pagesCount).toBe(1);
expect(pdfResult.info.extractionNotes).toContain(
  "Text extraction from vector-based PDFs is not supported.",
);
```

Such PDFs will have:

- `textExtractionSuccess: false`
- `isVectorBased: true`
- Explanatory message in `extractionNotes`

### Example 4: ZIP Archive Validation

**Context**: Validate ZIP contains expected files and extract specific file.

**Implementation**:

```typescript
import { readZIP } from "@seontechnologies/playwright-utils/file-utils";

test("should validate ZIP archive", async () => {
  const downloadPath = await handleDownload({
    page,
    downloadDir: DOWNLOAD_DIR,
    trigger: () => page.click('[data-testid="download-backup"]'),
  });

  const zipResult = await readZIP({ filePath: downloadPath });

  // Check file list
  expect(Array.isArray(zipResult.content.entries)).toBe(true);
  expect(zipResult.content.entries).toContain(
    "Case_53125_10-19-22_AM/Case_53125_10-19-22_AM_case_data.csv",
  );

  // Extract specific file
  const targetFile = "Case_53125_10-19-22_AM/Case_53125_10-19-22_AM_case_data.csv";
  const zipWithExtraction = await readZIP({
    filePath: downloadPath,
    fileToExtract: targetFile,
  });

  // Access extracted file buffer
  const extractedFiles = zipWithExtraction.content.extractedFiles || {};
  const fileBuffer = extractedFiles[targetFile];
  expect(fileBuffer).toBeInstanceOf(Buffer);
  expect(fileBuffer?.length).toBeGreaterThan(0);
});
```

**Key Points**:

- `content.entries` lists all files in archive
- `fileToExtract` extracts specific files to Buffer
- Validate archive structure
- Read and parse individual files from ZIP

### Example 5: API-Triggered Download

**Context**: API endpoint returns file download (not UI click).

**Implementation**:

```typescript
test("should download via API", async ({ page, request }) => {
  const downloadPath = await handleDownload({
    page, // Still need page for download events
    downloadDir: DOWNLOAD_DIR,
    trigger: async () => {
      const response = await request.get("/api/export/csv", {
        headers: { Authorization: "Bearer token" },
      });

      if (!response.ok()) {
        throw new Error(`Export failed: ${response.status()}`);
      }
    },
  });

  const { content } = await readCSV({ filePath: downloadPath });

  expect(content.data).toHaveLength(100);
});
```

**Key Points**:

- `trigger` can be async API call
- API must return `Content-Disposition` header
- Still need `page` for download events
- Works with authenticated endpoints

### Example 6: Reading CSV from Buffer (ZIP extraction)

**Context**: Read CSV content directly from a Buffer (e.g., extracted from ZIP).

**Implementation**:

```typescript
// Read from a Buffer (e.g., extracted from a ZIP)
const zipResult = await readZIP({
  filePath: "archive.zip",
  fileToExtract: "data.csv",
});
const fileBuffer = zipResult.content.extractedFiles?.["data.csv"];
const csvFromBuffer = await readCSV({ content: fileBuffer });

// Read from a string
const csvString = "name,age\nJohn,30\nJane,25";
const csvFromString = await readCSV({ content: csvString });

const { data, headers } = csvFromString.content;
expect(headers).toContain("name");
expect(headers).toContain("age");
```

## API Reference

### CSV Reader Options

| Option         | Type               | Default  | Description                            |
| -------------- | ------------------ | -------- | -------------------------------------- |
| `filePath`     | `string`           | -        | Path to CSV file (mutually exclusive)  |
| `content`      | `string \| Buffer` | -        | Direct content (mutually exclusive)    |
| `delimiter`    | `string \| 'auto'` | `','`    | Value separator, auto-detect if 'auto' |
| `encoding`     | `string`           | `'utf8'` | File encoding                          |
| `parseHeaders` | `boolean`          | `true`   | Use first row as headers               |
| `trim`         | `boolean`          | `true`   | Trim whitespace from values            |

### XLSX Reader Options

| Option      | Type     | Description                    |
| ----------- | -------- | ------------------------------ |
| `filePath`  | `string` | Path to XLSX file              |
| `sheetName` | `string` | Name of sheet to set as active |

### PDF Reader Options

| Option       | Type      | Default | Description                 |
| ------------ | --------- | ------- | --------------------------- |
| `filePath`   | `string`  | -       | Path to PDF file (required) |
| `mergePages` | `boolean` | `true`  | Merge text from all pages   |
| `maxPages`   | `number`  | -       | Maximum pages to extract    |
| `debug`      | `boolean` | `false` | Enable debug logging        |

### ZIP Reader Options

| Option          | Type     | Description                        |
| --------------- | -------- | ---------------------------------- |
| `filePath`      | `string` | Path to ZIP file                   |
| `fileToExtract` | `string` | Specific file to extract to Buffer |

### Return Values

#### CSV Reader Return Value

```typescript
{
  content: {
    data: Array<Array<string | number>>,  // Parsed rows (excludes header row if parseHeaders: true)
    headers: string[] | null              // Column headers (null if parseHeaders: false)
  }
}
```

#### XLSX Reader Return Value

```typescript
{
  content: {
    worksheets: Array<{
      name: string; // Sheet name
      rows: Array<Array<any>>; // All rows including headers
      headers?: string[]; // First row as headers (if present)
    }>;
  }
}
```

#### PDF Reader Return Value

```typescript
{
  content: string,                        // Extracted text (merged or per-page based on mergePages)
  pagesCount: number,                     // Total pages in PDF
  fileName?: string,                      // Original filename if available
  info?: Record<string, any>              // PDF metadata (author, title, etc.)
}
```

> **Note**: When `mergePages: false`, `content` is an array of strings (one per page). When `maxPages` is set, only that many pages are extracted.

#### ZIP Reader Return Value

```typescript
{
  content: {
    entries: Array<{
      name: string,                       // File/directory path within ZIP
      size: number,                       // Uncompressed size in bytes
      isDirectory: boolean                // True for directories
    }>,
    extractedFiles: Record<string, Buffer | string>  // Extracted file contents by path
  }
}
```

> **Note**: When `fileToExtract` is specified, only that file appears in `extractedFiles`.

## Download Cleanup Pattern

```typescript
test.afterEach(async () => {
  // Clean up downloaded files
  await fs.remove(DOWNLOAD_DIR);
});
```

## Comparison with Vanilla Playwright

Vanilla Playwright (real test) snippet:

```typescript
// ~80 lines of boilerplate!
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByTestId("download-button-CSV Export").click(),
]);

const failure = await download.failure();
expect(failure).toBeNull();

const filePath = testInfo.outputPath(download.suggestedFilename());
await download.saveAs(filePath);

await expect
  .poll(
    async () => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 5000, intervals: [100, 200, 500] },
  )
  .toBe(true);

const csvContent = await fs.readFile(filePath, "utf-8");

const parseResult = parse(csvContent, {
  header: true,
  skipEmptyLines: true,
  dynamicTyping: true,
  transformHeader: (header: string) => header.trim(),
});

if (parseResult.errors.length > 0) {
  throw new Error(`CSV parsing errors: ${JSON.stringify(parseResult.errors)}`);
}

const data = parseResult.data as Array<Record<string, unknown>>;
const headers = parseResult.meta.fields || [];
```

With File Utils, the same flow becomes:

```typescript
const downloadPath = await handleDownload({
  page,
  downloadDir: DOWNLOAD_DIR,
  trigger: () => page.getByTestId("download-button-text/csv").click(),
});

const { data, headers } = (await readCSV({ filePath: downloadPath })).content;
```

## Related Fragments

- `overview.md` - Installation and imports
- `api-request.md` - API-triggered downloads
- `recurse.md` - Poll for file generation completion

## Anti-Patterns

**DON'T leave downloads in place:**

```typescript
test('creates file', async () => {
  await handleDownload({ ... })
  // File left in downloads folder
})
```

**DO clean up after tests:**

```typescript
test.afterEach(async () => {
  await fs.remove(DOWNLOAD_DIR);
});
```
