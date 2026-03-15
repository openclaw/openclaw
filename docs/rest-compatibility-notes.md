# REST Compatibility Notes

REST is optional future compatibility only.

For `radar-claw-defender`, MCP is the primary integration boundary.

V1 does not implement a REST-first architecture or a generic HTTP analysis service. If a compatibility layer is added later, it should:

- expose the same narrow defensive tool surface
- preserve the MCP-first trust model
- avoid widening the capability boundary
