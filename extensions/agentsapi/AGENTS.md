# Agents API package

- Always use the official OpenAI `openai` npm SDK for Agents API operations
  whenever it supports the operation.
- Do not implement raw HTTP requests, custom endpoint clients, or parallel
  request/response handling for operations supported by the official SDK.
- Raw HTTP is permitted only when the official SDK cannot express the required
  operation. Document that specific SDK gap alongside the implementation.
