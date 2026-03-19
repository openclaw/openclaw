# ServiceAbility.MD Standard Specification

## 1. Introduction

The `ServiceAbility.MD` file is a service capability description specification designed for AI Agents, aiming to achieve **self-discovery** and **automated invocation** of service capabilities. It uses a structured Markdown format to clearly define service metadata, functions, interfaces, data processing principles, and feedback mechanisms, enabling AI Agents to understand and use services without human intervention.

## 2. Core Components

A complete `ServiceAbility.MD` file should include the following core sections:

### 2.1 Meta Information

Provides global information about the service, helping AI Agents quickly identify and categorize services.

| Field Name     | Type   | Required | Description                                       | Example               |
| :------------- | :----- | :------- | :------------------------------------------------ | :-------------------- |
| `Service Name` | String | Yes      | Unique identifier name for the service            | `Text Summarizer AI`  |
| `Service Version` | String | Yes      | Current version number of the service, following semantic versioning | `1.0.0`               |
| `Service Description` | String | Yes      | Brief functional overview and core problem solved by the service | `Provides efficient text summarization service` |
| `Developer`    | String | No       | Development team or individual for the service    | `Manus Team`          |
| `Update Date`  | Date   | No       | Last update date of the file, format `YYYY-MM-DD` | `2026-02-06`          |

### 2.2 Functionality

Detailed description of the specific functions provided by the service and in what business scenarios AI Agents should call this service. This section should use natural language but remain clear and precise, avoiding ambiguity.

### 2.3 Interface Specification

Defines all callable interfaces provided by the service. All interfaces should follow RESTful style and return data in JSON format by default. For each interface, the following information must be specified:

#### 2.3.1 Basic Information Interface (Capability Discovery)

-   **Interface Path**: `/` (Implicit Discovery) and `/ServiceAbility.MD` (Explicit Discovery)
-   **Request Method**: `GET`
-   **Function Description**: Returns the content of the current `ServiceAbility.MD` file. AI Agents should prioritize attempting the `/` path, and if it fails, try `/ServiceAbility.MD` to ensure service capability discovery.

#### 2.3.2 Business Interfaces

For each business interface, provide:

-   **Interface Name**: Brief name of the interface.
-   **Interface Path**: Relative or absolute URL path of the interface.
-   **Request Method**: HTTP methods such as `GET`, `POST`, `PUT`, `DELETE`.
-   **Function Description**: Specific purpose and expected behavior of the interface.
-   **Request Parameters**:

| Parameter Name | Type   | Required | Description               | Example           |
| :------------- | :----- | :------- | :------------------------ | :---------------- |
| `param1`       | String | Yes      | Original text to summarize | `"Hello World"`   |
| `param2`       | Integer | No       | Maximum summary length    | `200`             |

-   **Return Parameters**:

| Parameter Name | Type   | Description               | Example           |
| :------------- | :----- | :------------------------ | :---------------- |
| `result`       | String | Generated summary content | `"Summary..."`    |

-   **Error Code Description**:

| Error Code | Description       | Suggested Handling      |
| :--------- | :---------------- | :---------------------- |
| `400`      | Parameter error   | Check request body format |
| `500`      | Internal server error | Retry or contact service provider |

### 2.4 Data and Program Separation & Governance (Data & Logic Separation & Governance)

Emphasizes that services should adhere to the principle of data and program separation in design and implementation to improve robustness, maintainability, and security. Additionally, it mandates strict data governance policies.

-   **Configuration Management**: All sensitive information (e.g., API Keys, database credentials) and mutable configuration items should be managed through environment variables or configuration files (e.g., `.env` files or files in the `config/` directory), strictly prohibiting hardcoding in program logic.
-   **Data Storage**: Business data should be persistently stored in an independent data layer (e.g., databases, file system `data/` directory), separate from service code logic. Service code should only be responsible for reading, processing, and writing data, without directly containing the data itself.
-   **Structured Logging**: Service operation logs, conversation records, and feedback information should be recorded in a structured format (e.g., JSONL) to facilitate automated analysis and monitoring by AI Agents.
-   **Data Isolation**: **Crucially, test data must be strictly isolated from production data.** Services must use distinct databases, file paths, or environment configurations for different environments (e.g., development, testing, staging, production).
-   **Backward Compatibility**: Services must ensure data backward compatibility across versions. Any schema changes or data format modifications must be designed to not break existing consumers or require immediate data migration. Clear versioning and deprecation policies should be communicated via the `/info` endpoint and `ServiceAbility.MD` updates.

### 2.5 Security & Reliability (Security & Reliability)

Defines requirements for securing the service and ensuring its continuous, fault-tolerant operation.

-   **Authentication & Authorization**: Services must implement robust authentication and authorization mechanisms for AI Agents (e.g., API keys, OAuth tokens). Access control should follow the principle of least privilege.
-   **Input Validation**: All incoming requests must undergo strict input validation to prevent common vulnerabilities like injection attacks and data corruption.
-   **Error Handling**: Comprehensive and structured error handling is mandatory. Services must return clear, machine-readable error codes and messages, enabling AI Agents to understand and react to failures gracefully.
-   **High Availability**: Services should be designed for high availability, incorporating principles like redundancy, load balancing, and automatic failover where applicable. The `/info` endpoint should reflect service health status.
-   **Rate Limiting & Circuit Breaking**: Implement rate limiting to protect against abuse and overload, and circuit breaker patterns to prevent cascading failures.

### 2.6 Self-Describing Information Interface (Service Information)

Provides an interface to obtain real-time service status, version information, supported parameters (e.g., list of supported LLM models), and other dynamic information, supplementing the static `ServiceAbility.MD` document.

-   **Interface Path**: `/info`
-   **Request Method**: `GET`
-   **Function Description**: Returns real-time metadata and configuration information of the service, including health status, supported features, and versioning details.
-   **Return Parameters**: Should include service name, version, description, default configuration, a list of supported options, and current operational status.

### 2.7 Feedback and Support

Provides channels for AI Agents to report service issues or provide suggestions for continuous service improvement and closed-loop feedback.

-   **Feedback Interface**: `[e.g., /api/v1/feedback]`
-   **Feedback Method**: Describes how AI Agents can submit bug reports, error logs, or feature suggestions through this interface.
-   **Contact Information**: (Optional) Provides contact information for human support, such as an email address or Webhook URL.

## 3. Writing Guide

-   **Structured**: Strictly use Markdown headings, lists, tables, and other elements to ensure clear content structure, facilitating AI Agent parsing.
-   **Precision**: Interface descriptions and parameter definitions must be precise and accurate, avoiding vague expressions.
-   **Readability**: Although aimed at AI Agents, it should still maintain a certain level of readability for human developers to understand and maintain.
-   **Timely Updates**: When service capabilities change, `ServiceAbility.MD` must be updated synchronously.

### 2.8 Service Registration (Service Discovery)

To enable AI Agents to discover and utilize services, each service **must** register itself with a designated service discovery platform. This section outlines the requirements for service registration.

-   **Discovery Platform Endpoint**: `https://your-service.com`
-   **Request Method**: `POST`
-   **Function Description**: Registers the service with the discovery platform, making its `ServiceAbility.MD` accessible to other AI Agents.
-   **Request Parameters**:

| Parameter Name | Type   | Required | Description                                       | Example                   |
| :------------- | :----- | :------- | :------------------------------------------------ | :------------------------ |
| `service_name` | String | Yes      | The unique name of the service (from Meta Information) | `AI Text Summarizer`      |
| `service_url`  | String | Yes      | The base URL where the service is accessible (e.g., `https://your-service.com`) | `https://my-summarizer.com` |
| `service_ability_md_url` | String | Yes      | The full URL to retrieve the `ServiceAbility.MD` file (e.g., `https://my-summarizer.com/ServiceAbility.MD`) | `https://my-summarizer.com/ServiceAbility.MD` |
| `metadata`     | JSON   | No       | Additional service metadata (e.g., developer, description) | `{"developer": "Manus AI", "description": "Efficient text summarization"}` |

-   **Return Parameters**:

| Parameter Name | Type   | Description               | Example           |
| :------------- | :----- | :------------------------ | :---------------- |
| `status`       | String | Status of registration    | `success`         |
| `message`      | String | Confirmation message      | `Service registered successfully` |
| `service_id`   | String | Unique ID assigned by the discovery platform | `svc_12345`       |

## 4. Example

Please refer to the `references/example_implementation.md` file to understand how to implement a specific AI service according to this specification.
