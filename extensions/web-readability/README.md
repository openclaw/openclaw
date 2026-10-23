# Web Readability

Extract an article's main content from HTML returned by OpenClaw's web fetch
feature. The plugin removes surrounding page markup and produces readable text
or Markdown using Mozilla Readability.

## Get started

The plugin is enabled by default and needs no API key. Keep web fetching enabled
and use `tools.web.fetch.readability` to control Readability extraction. Ask
your agent to fetch a page to use the extractor through the normal web flow.

Extraction runs locally on fetched HTML. It does not execute page JavaScript,
sign in to websites, or make every page readable; interactive and protected
pages may need a browser.

See the [Web fetch guide](https://docs.openclaw.ai/tools/web-fetch) for extraction
settings and supported page formats.
