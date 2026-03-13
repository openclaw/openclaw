---
summary: Channel agnostic session binding architecture and iteration 1 delivery scope
read_when:
  - Refactoring channel-agnostic session routing and bindings
  - "Investigating duplicate, stale, or missing session delivery across channels"
owner: onutc
status: in-progress
last_updated: "2026-02-21"
title: Session Binding Channel Agnostic Plan
---

# Session Binding Channel Agnostic Plan

## 概述

本文件定義了長期的通道無關會話綁定模型以及下一次實作迭代的具體範圍。

目標：

- 使子代理綁定會話路由成為核心功能
- 將通道特定行為保留在適配器中
- 避免正常 Discord 行為的回歸

## 為什麼會有這個

當前行為混合：

- 完成內容政策
- 目的地路由政策
- Discord 特定細節

這導致了邊緣案例，例如：

- 在並行執行中重複主線程和線程交付
- 在重用綁定管理器時使用過期的 token
- 缺少對 webhook 發送的活動記錄

## Iteration 1 範圍

這次迭代是故意有限制的。

### 1. 新增與通道無關的核心介面

新增核心類型和服務介面以進行綁定和路由。

提議的核心類型：

ts
export type BindingTargetKind = "subagent" | "session";
export type BindingStatus = "active" | "ending" | "ended";

export type ConversationRef = {
channel: string;
accountId: string;
conversationId: string;
parentConversationId?: string;
};

typescript
export type SessionBindingRecord = {
bindingId: string;
targetSessionKey: string;
targetKind: BindingTargetKind;
conversation: ConversationRef;
status: BindingStatus;
boundAt: number;
expiresAt?: number;
metadata?: Record<string, unknown>;
};

核心服務合約：

ts
export interface SessionBindingService {
bind(input: {
targetSessionKey: string;
targetKind: BindingTargetKind;
conversation: ConversationRef;
metadata?: Record<string, unknown>;
ttlMs?: number;
}): Promise<SessionBindingRecord>;

listBySession(targetSessionKey: string): SessionBindingRecord[];
resolveByConversation(ref: ConversationRef): SessionBindingRecord | null;
touch(bindingId: string, at?: number): void;
unbind(input: {
bindingId?: string;
targetSessionKey?: string;
reason: string;
}): Promise<SessionBindingRecord[]>;
}

### 2. 為子代理完成添加一個核心交付路由器

新增單一目的地解析路徑以處理完成事件。

Router contract:

```ts
export interface BoundDeliveryRouter {
  resolveDestination(input: {
    eventKind: "task_completion";
    targetSessionKey: string;
    requester?: ConversationRef;
    failClosed: boolean;
  }): {
    binding: SessionBindingRecord | null;
    mode: "bound" | "fallback";
    reason: string;
  };
}
```

這次迭代：

- 只有 `task_completion` 透過這條新路徑進行路由
- 其他事件類型的現有路徑保持不變

### 3. 保持 Discord 作為適配器

Discord 仍然是第一個適配器實作。

適配器的責任：

- 創建/重用線程對話
- 通過 webhook 或頻道發送綁定消息
- 驗證線程狀態（已存檔/已刪除）
- 映射適配器元數據（webhook 身份、線程 ID）

### 4. 修正目前已知的正確性問題

此迭代中需要：

- 當重複使用現有的執行緒綁定管理器時，刷新 token 的使用
- 記錄針對 webhook 基於 Discord 發送的外部活動
- 當選擇綁定的執行緒目的地以完成會話模式時，停止隱式主頻道回退

### 5. 保留當前的執行時安全預設值

對於禁用線程綁定生成的用戶，行為不會改變。

Defaults stay:

`channels.discord.threadBindings.spawnSubagentSessions = false`

結果：

- 正常的 Discord 使用者保持目前的行為
- 新的核心路徑僅影響啟用的綁定會話完成路由

## Not in iteration 1

[[BLOCK_1]]

- ACP 綁定目標 (`targetKind: "acp"`)
- 超越 Discord 的新通道適配器
- 所有傳遞路徑的全球替換 (`spawn_ack`, 未來 `subagent_message`)
- 協議層級變更
- 所有綁定持久性的商店遷移/版本設計重構

[[BLOCK_1]]

- 介面設計保留了 ACP 的空間
- 本次迭代尚未開始 ACP 的實作

## Routing invariants

這些不變條件是第一迭代的必要條件。

- 目的地選擇和內容生成是兩個獨立的步驟
- 如果會話模式完成解析為一個活躍的綁定目的地，則交付必須針對該目的地
- 不得從綁定目的地隱藏重定向到主通道
- 回退行為必須是明確且可觀察的

## 兼容性與推出計畫

[[BLOCK_1]]  
相容性目標：  
[[BLOCK_1]]

- 對於關閉執行緒綁定的使用者，沒有回歸問題
- 在這次迭代中，對非 Discord 頻道沒有變更

[[BLOCK_1]]

1. 將介面和路由器放置在當前功能閘後面。
2. 通過路由器路由 Discord 完成模式的綁定交付。
3. 保留非綁定流程的舊有路徑。
4. 透過針對性的測試和金絲雀執行時日誌進行驗證。

## 迭代 1 中所需的測試

[[BLOCK_1]] 單元和整合測試覆蓋率要求：[[BLOCK_1]]

- 管理員的 token 旋轉在管理員重用後使用最新的 token
- webhook 發送更新的頻道活動時間戳
- 同一請求者頻道中的兩個活躍綁定會話不會重複到主頻道
- 綁定會話模式執行的完成僅解析到線程目的地
- 禁用的 spawn 標誌保持舊版行為不變

## 提議的實作檔案

Core:

- `src/infra/outbound/session-binding-service.ts` (new)
- `src/infra/outbound/bound-delivery-router.ts` (new)
- `src/agents/subagent-announce.ts` (完成目的地解析整合)

Discord 適配器和執行時：

- `src/discord/monitor/thread-bindings.manager.ts`
- `src/discord/monitor/reply-delivery.ts`
- `src/discord/send.outbound.ts`

Tests:

- `src/discord/monitor/provider*.test.ts`
- `src/discord/monitor/reply-delivery.test.ts`
- `src/agents/subagent-announce.format.test.ts`

## Done criteria for iteration 1

- 核心介面已存在並已連接以完成路由
- 上述正確性修正已合併並附有測試
- 在會話模式綁定執行中，沒有主線程和執行緒重複的完成交付
- 對於禁用的綁定生成部署，沒有行為變更
- ACP 仍然明確延遲
