"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
exports = module.exports = function (...args) {
  return new exports.default(...args)
}
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureOpenAI = exports.InvalidWebhookSignatureError = exports.UnprocessableEntityError = exports.PermissionDeniedError = exports.InternalServerError = exports.AuthenticationError = exports.BadRequestError = exports.RateLimitError = exports.ConflictError = exports.NotFoundError = exports.APIUserAbortError = exports.APIConnectionTimeoutError = exports.APIConnectionError = exports.APIError = exports.OpenAIError = exports.PagePromise = exports.OpenAI = exports.APIPromise = exports.toFile = exports.default = void 0;
var client_1 = require("./client.js");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return client_1.OpenAI; } });
var uploads_1 = require("./core/uploads.js");
Object.defineProperty(exports, "toFile", { enumerable: true, get: function () { return uploads_1.toFile; } });
var api_promise_1 = require("./core/api-promise.js");
Object.defineProperty(exports, "APIPromise", { enumerable: true, get: function () { return api_promise_1.APIPromise; } });
var client_2 = require("./client.js");
Object.defineProperty(exports, "OpenAI", { enumerable: true, get: function () { return client_2.OpenAI; } });
var pagination_1 = require("./core/pagination.js");
Object.defineProperty(exports, "PagePromise", { enumerable: true, get: function () { return pagination_1.PagePromise; } });
var error_1 = require("./core/error.js");
Object.defineProperty(exports, "OpenAIError", { enumerable: true, get: function () { return error_1.OpenAIError; } });
Object.defineProperty(exports, "APIError", { enumerable: true, get: function () { return error_1.APIError; } });
Object.defineProperty(exports, "APIConnectionError", { enumerable: true, get: function () { return error_1.APIConnectionError; } });
Object.defineProperty(exports, "APIConnectionTimeoutError", { enumerable: true, get: function () { return error_1.APIConnectionTimeoutError; } });
Object.defineProperty(exports, "APIUserAbortError", { enumerable: true, get: function () { return error_1.APIUserAbortError; } });
Object.defineProperty(exports, "NotFoundError", { enumerable: true, get: function () { return error_1.NotFoundError; } });
Object.defineProperty(exports, "ConflictError", { enumerable: true, get: function () { return error_1.ConflictError; } });
Object.defineProperty(exports, "RateLimitError", { enumerable: true, get: function () { return error_1.RateLimitError; } });
Object.defineProperty(exports, "BadRequestError", { enumerable: true, get: function () { return error_1.BadRequestError; } });
Object.defineProperty(exports, "AuthenticationError", { enumerable: true, get: function () { return error_1.AuthenticationError; } });
Object.defineProperty(exports, "InternalServerError", { enumerable: true, get: function () { return error_1.InternalServerError; } });
Object.defineProperty(exports, "PermissionDeniedError", { enumerable: true, get: function () { return error_1.PermissionDeniedError; } });
Object.defineProperty(exports, "UnprocessableEntityError", { enumerable: true, get: function () { return error_1.UnprocessableEntityError; } });
Object.defineProperty(exports, "InvalidWebhookSignatureError", { enumerable: true, get: function () { return error_1.InvalidWebhookSignatureError; } });
var azure_1 = require("./azure.js");
Object.defineProperty(exports, "AzureOpenAI", { enumerable: true, get: function () { return azure_1.AzureOpenAI; } });
//# sourceMappingURL=index.js.map