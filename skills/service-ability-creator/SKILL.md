---
name: service-ability-creator
description: 指导 OpenClaw Agent 开发和升级“面向 AI 的服务 (Service for AI)”。该技能专注于创建无前端页面、通过 ServiceAbility.MD 实现能力自发现的闭环服务，确保逻辑合理、简洁优美且易于模型理解。
version: 1.2.0
author: Manus AI
triggers:
  - OpenClaw Service
  - ServiceAbility.MD
  - AI Agent Skill
  - Develop AI Service
tools_required:
  - file
  - shell
  - default_api
---

# Service Ability Creator (OpenClaw Edition)

本技能旨在指导 **OpenClaw Agent** 开发一种特殊的服务形态：**面向 AI 的服务 (Service for AI)**。这类服务不提供传统的用户界面 (UI)，而是通过结构化的 `ServiceAbility.MD` 文件向其他 AI Agent 宣告其能力，实现自动化的能力发现与调用。

## 核心原则

| 原则 | 描述 |
| :--- | :--- |
| **AI 优先 (AI-First)** | 服务设计以机器解析和自动化调用为核心，而非人类阅读。 |
| **自发现性 (Self-Discoverability)** | 服务必须在根路径 `/` 或 `/ServiceAbility.MD` 默认返回能力说明文件。 |
| **闭环性 (Closed-Loop)** | 提供从请求处理到结果返回的完整业务逻辑，并包含反馈机制。 |
| **生产级标准 (Production-Grade)** | 遵循 S.A.F.E. 分析方法，确保安全、可用、容错与演进性。 |

---

## 开发工作流 (C.O.R.E. Build Flow)

按照以下四个阶段构建您的 OpenClaw AI 服务。每个阶段都应确保逻辑的简洁与优美。

### 1. 配置与定义 (Configuration)
> **目标**：确立服务的“合同”与环境。

- **定义 ServiceAbility**：参考 `assets/ServiceAbility.MD.template` 编写服务说明。
  - 明确 Meta 信息（名称、版本、描述）。
  - 定义核心功能与接口规范（路径、方法、参数、返回格式）。
  - 设定数据治理原则（数据程序分离、测试/生产隔离）。
- **环境初始化**：
  - 推荐技术栈：FastAPI (Python) 或 Express (Node.js)。
  - 建立标准目录结构：`core/` (逻辑), `data/` (存储), `config/` (配置), `ServiceAbility.MD` (合同)。

### 2. 核心实现 (Operation)
> **目标**：构建闭环的业务逻辑。

- **实现自发现接口**：
  - `GET /` 或 `GET /ServiceAbility.MD`：直接返回 `ServiceAbility.MD` 文件内容。
  - `GET /info`：返回实时元数据（如版本、健康状态、动态配置）。
- **开发业务接口**：
  - 严格遵循 `ServiceAbility.MD` 定义的 RESTful 风格。
  - 实现结构化日志记录（推荐 JSONL 格式）。
- **集成反馈机制**：
  - 实现 `/api/v1/feedback` 接口，允许调用方 AI 报告异常或建议。

### 3. 评审与验证 (Review)
> **目标**：确保服务的健壮性与安全性。

- **自动化测试**：执行单元测试与集成测试，验证接口返回是否符合 `ServiceAbility.MD` 规范。
- **S.A.F.E. 审计**：
  - **Security**：验证 API Key 鉴权与输入校验。
  - **Availability**：检查错误处理与超时机制。
  - **Fault-tolerance**：验证异常情况下的结构化错误返回。

---

## 产出标准 (Output Specification)

一个优秀的 OpenClaw AI 服务应满足以下清单：

- [ ] **自描述**：根路径及 `/ServiceAbility.MD` 必须返回有效的 Markdown 说明。
- [ ] **规范化**：接口路径、参数、错误码与 `ServiceAbility.MD` 严格一致。
- [ ] **数据分离**：代码中无硬编码配置，业务数据存储于独立目录或数据库。
- [ ] **闭环反馈**：具备 `/info` 状态接口和反馈收集接口。
- [ ] **健壮性**：拥有完善的错误捕获，返回机器可读的结构化 JSON 错误信息。
- [ ] **隔离性**：测试环境与生产环境的数据、配置完全隔离。

## 参考资源

- **标准规范**：`references/ServiceAbility_Standard_Specification.md`
- **能力模板**：`assets/ServiceAbility.MD.template`
- **实现示例**：`references/example_implementation.md`
- **核心概念**：`references/SAFE_CORE_Concepts.md`

---
*注：本技能是通用的服务创建指南，旨在帮助 OpenClaw Agent 构建可被生态系统理解的高质量后端能力。*
