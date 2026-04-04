# Agentic CI/CD Constitution

不可變核心規則。修改本文件本身是 L3 操作。

## 第一條：Secrets 永不自動合併

任何包含 secrets、credentials、API keys 的變更，永遠需要人類確認。

## 第二條：L3 操作永遠需要人類簽名

不可逆操作（資料刪除、權限變更、合約修改）不可被自動化繞過。

## 第三條：規則變更本身受控

修改 `protocol.json` 是 L2 操作。修改 `constitution.md` 是 L3 操作。

## 第四條：Agent 身份隔離

每個 agent 只能在自己的 scope 內操作。杜甫不能動 Andrew 的檔案，Andrew 不能動 Cafe 的程式碼。

## 第五條：緊急煞車

Cruz 可以隨時凍結所有 L0/L1 自動操作。一個指令，全面停止。

## 第六條：審計軌跡不可刪除

所有 agent 操作必須記錄。audit log 是 append-only。

## 第七條：Sentinel 擁有一票否決權

如果 Sentinel 健康檢查報紅，任何 L0/L1 合併自動暫停。
