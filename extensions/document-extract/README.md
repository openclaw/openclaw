# Document Extraction

Extract text from PDF attachments locally. When a selected page has too little
text, the plugin can render it as an image for a vision-capable model. PDF
processing runs in a worker through the bundled PDFium-based extractor.

## Get started

The plugin is enabled by default and needs no extraction API key. Configure a
model for PDF analysis, then attach a PDF or ask your agent to analyze a local
PDF file.

Local extraction and model analysis are separate: the selected model still
needs its normal credentials. Models with native PDF support can receive the
document directly instead. This extractor handles PDFs, not every document
format.

See the [PDF guide](https://docs.openclaw.ai/tools/pdf) for model selection,
page limits, and encrypted documents.
