---
summary: "Cách bộ nhớ OpenClaw hoạt động (tệp workspace + xả bộ nhớ tự động)"
read_when:
  - Bạn muốn biết bố cục tệp bộ nhớ và quy trình làm việc
  - Bạn muốn tinh chỉnh cơ chế xả bộ nhớ tự động trước khi nén
---

# Memory

14. Bộ nhớ OpenClaw là **Markdown thuần trong workspace của agent**. The files are the
    source of truth; the model only "remembers" what gets written to disk.

15. Công cụ tìm kiếm bộ nhớ được cung cấp bởi plugin bộ nhớ đang hoạt động (mặc định: `memory-core`). 16. Tắt plugin bộ nhớ bằng `plugins.slots.memory = "none"`.

## Memory files (Markdown)

Bố cục workspace mặc định dùng hai lớp bộ nhớ:

- `memory/YYYY-MM-DD.md`
  - Nhật ký hằng ngày (chỉ ghi thêm).
  - Đọc hôm nay + hôm qua khi bắt đầu phiên.
- `MEMORY.md` (tùy chọn)
  - Bộ nhớ dài hạn đã được tuyển chọn.
  - **Chỉ tải trong phiên chính, riêng tư** (không bao giờ trong ngữ cảnh nhóm).

17. Các tệp này nằm dưới workspace (`agents.defaults.workspace`, mặc định `~/.openclaw/workspace`). 18. Xem [Agent workspace](/concepts/agent-workspace) để biết bố cục đầy đủ.

## Khi nào ghi bộ nhớ

- Quyết định, sở thích và sự thật bền vững ghi vào `MEMORY.md`.
- Ghi chú hằng ngày và ngữ cảnh đang chạy ghi vào `memory/YYYY-MM-DD.md`.
- Nếu ai đó nói “hãy nhớ điều này”, hãy ghi lại (đừng giữ trong RAM).
- 19. Khu vực này vẫn đang phát triển. 20. Việc nhắc mô hình lưu bộ nhớ là hữu ích; nó sẽ biết phải làm gì.
- Nếu bạn muốn điều gì đó được ghi nhớ, **hãy yêu cầu bot ghi vào bộ nhớ**.

## Automatic memory flush (pre-compaction ping)

21. Khi một phiên **gần đến auto-compaction**, OpenClaw kích hoạt một **lượt tác tử im lặng** để nhắc mô hình ghi bộ nhớ bền vững **trước khi** context bị nén gọn. 22. Các prompt mặc định nói rõ mô hình _có thể trả lời_, nhưng thường thì `NO_REPLY` là phản hồi đúng để người dùng không bao giờ thấy lượt này.

Cơ chế này được điều khiển bởi `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Chi tiết:

- **Ngưỡng mềm**: xả bộ nhớ được kích hoạt khi ước lượng token của phiên vượt
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Im lặng** theo mặc định: lời nhắc bao gồm `NO_REPLY` nên không có gì được gửi ra.
- **Hai lời nhắc**: một lời nhắc người dùng cộng với một lời nhắc hệ thống để thêm nhắc nhở.
- **Một lần xả cho mỗi chu kỳ nén** (theo dõi trong `sessions.json`).
- **Workspace phải ghi được**: nếu phiên chạy trong sandbox với
  `workspaceAccess: "ro"` hoặc `"none"`, việc xả sẽ bị bỏ qua.

Để biết toàn bộ vòng đời nén, xem
[Session management + compaction](/reference/session-management-compaction).

## Vector memory search

OpenClaw có thể xây dựng một chỉ mục vector nhỏ trên `MEMORY.md` và `memory/*.md` để
các truy vấn ngữ nghĩa có thể tìm ghi chú liên quan ngay cả khi cách diễn đạt khác nhau.

Mặc định:

- Bật theo mặc định.
- Theo dõi thay đổi của tệp bộ nhớ (debounce).
- 23. Sử dụng embeddings từ xa theo mặc định. 24. Nếu `memorySearch.provider` không được đặt, OpenClaw tự động chọn:
  1. `local` nếu `memorySearch.local.modelPath` được cấu hình và tệp tồn tại.
  2. `openai` nếu có thể phân giải khóa OpenAI.
  3. `gemini` nếu có thể phân giải khóa Gemini.
  4. `voyage` nếu có thể phân giải khóa Voyage.
  5. Nếu không, tìm kiếm bộ nhớ sẽ bị vô hiệu cho đến khi được cấu hình.
- Chế độ local dùng node-llama-cpp và có thể cần `pnpm approve-builds`.
- Dùng sqlite-vec (khi có) để tăng tốc tìm kiếm vector trong SQLite.

25. Embeddings từ xa **yêu cầu** API key cho nhà cung cấp embedding. 26. OpenClaw phân giải khóa từ auth profiles, `models.providers.*.apiKey`, hoặc biến môi trường. 27. Codex OAuth chỉ bao phủ chat/completions và **không** đáp ứng embeddings cho tìm kiếm bộ nhớ. For Gemini, use `GEMINI_API_KEY` or
    `models.providers.google.apiKey`. 29. Với Voyage, sử dụng `VOYAGE_API_KEY` hoặc `models.providers.voyage.apiKey`. When using a custom OpenAI-compatible endpoint,
    set `memorySearch.remote.apiKey` (and optional `memorySearch.remote.headers`).

### QMD backend (experimental)

31. Đặt `memory.backend = "qmd"` để thay thế indexer SQLite tích hợp bằng [QMD](https://github.com/tobi/qmd): một sidecar tìm kiếm ưu tiên local kết hợp BM25 + vector + reranking. Markdown stays the source of truth; OpenClaw shells
    out to QMD for retrieval. 33. Các điểm chính:

**Prereqs**

- 34. Bị tắt theo mặc định. 35. Bật theo từng cấu hình (`memory.backend = "qmd"`).
- Cài QMD CLI riêng (`bun install -g https://github.com/tobi/qmd` hoặc tải
  bản phát hành) và đảm bảo binary `qmd` nằm trong `PATH` của gateway.
- QMD cần bản dựng SQLite cho phép extension (`brew install sqlite` trên
  macOS).
- QMD chạy hoàn toàn local qua Bun + `node-llama-cpp` và tự động tải model GGUF
  từ HuggingFace khi dùng lần đầu (không cần daemon Ollama riêng).
- Gateway chạy QMD trong một XDG home tự chứa dưới
  `~/.openclaw/agents/<agentId>/qmd/` bằng cách đặt `XDG_CONFIG_HOME` và
  `XDG_CACHE_HOME`.
- 21. Hỗ trợ hệ điều hành: macOS và Linux hoạt động ngay sau khi cài Bun + SQLite. Windows is best supported via WSL2.

**Cách sidecar chạy**

- Gateway ghi một QMD home tự chứa dưới
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + sqlite DB).
- Collection được tạo qua `qmd collection add` từ `memory.qmd.paths`
  (cộng với các tệp bộ nhớ workspace mặc định), sau đó `qmd update` + `qmd embed` chạy
  khi khởi động và theo khoảng thời gian cấu hình (`memory.qmd.update.interval`,
  mặc định 5 phút).
- Làm mới khi khởi động hiện chạy nền theo mặc định để không chặn khởi động chat;
  đặt `memory.qmd.update.waitForBootSync = true` để giữ hành vi chặn trước đây.
- 23. Các tìm kiếm chạy qua `qmd query --json`. 37. Nếu QMD thất bại hoặc thiếu binary, OpenClaw tự động quay về trình quản lý SQLite tích hợp để các công cụ bộ nhớ vẫn hoạt động.
- Hiện OpenClaw không phơi bày tinh chỉnh batch-size embedding của QMD; hành vi batch
  do QMD tự điều khiển.
- **Lần tìm đầu tiên có thể chậm**: QMD có thể tải model GGUF local (reranker/mở rộng truy vấn)
  ở lần chạy `qmd query` đầu tiên.
  - OpenClaw tự động đặt `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` khi chạy QMD.
  - Nếu muốn tải sẵn model thủ công (và làm ấm cùng chỉ mục OpenClaw dùng),
    hãy chạy một truy vấn một lần với các XDG dir của tác tử.

    38. Trạng thái QMD của OpenClaw nằm dưới **thư mục state** của bạn (mặc định `~/.openclaw`).
        You can point `qmd` at the exact same index by exporting the same XDG vars
        OpenClaw uses:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Bề mặt cấu hình (`memory.qmd.*`)**

- `command` (mặc định `qmd`): ghi đè đường dẫn executable.
- `includeDefaultMemory` (mặc định `true`): tự động lập chỉ mục `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: thêm thư mục/tệp bổ sung (`path`, tùy chọn `pattern`, tùy chọn
  ổn định `name`).
- `sessions`: chọn tham gia lập chỉ mục JSONL phiên (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: điều khiển nhịp làm mới và thực thi bảo trì:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: giới hạn payload recall (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: same schema as [`session.sendPolicy`](/gateway/configuration#session).
  41. Mặc định là chỉ DM (từ chối tất cả, cho phép chat trực tiếp); nới lỏng để hiển thị kết quả QMD trong nhóm/kênh.
- Đoạn trích lấy từ ngoài workspace hiển thị là
  `qmd/<collection>/<relative-path>` trong kết quả `memory_search`; `memory_get`
  hiểu tiền tố đó và đọc từ root collection QMD đã cấu hình.
- Khi `memory.qmd.sessions.enabled = true`, OpenClaw xuất transcript phiên đã được làm sạch
  (lượt User/Assistant) vào một collection QMD riêng dưới
  `~/.openclaw/agents/<id>/qmd/sessions/`, để `memory_search` có thể gọi lại các
  cuộc hội thoại gần đây mà không chạm vào chỉ mục SQLite tích hợp.
- Các snippet `memory_search` giờ bao gồm footer `Source: <path#line>` khi
  `memory.citations` là `auto`/`on`; đặt `memory.citations = "off"` để giữ
  metadata đường dẫn ở nội bộ (tác tử vẫn nhận đường dẫn cho
  `memory_get`, nhưng văn bản snippet bỏ footer và lời nhắc hệ thống
  cảnh báo tác tử không trích dẫn nó).

**Ví dụ**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Trích dẫn & fallback**

- `memory.citations` áp dụng bất kể backend (`auto`/`on`/`off`).
- 29. Khi `qmd` chạy, chúng tôi gắn thẻ `status().backend = "qmd"` để chẩn đoán hiển thị
      engine nào đã phục vụ kết quả. 42. Nếu subprocess QMD thoát hoặc đầu ra JSON không thể phân tích, trình quản lý tìm kiếm ghi log cảnh báo và trả về nhà cung cấp tích hợp (embeddings Markdown hiện có) cho đến khi QMD phục hồi.

### Additional memory paths

Nếu bạn muốn lập chỉ mục các tệp Markdown ngoài bố cục workspace mặc định, hãy thêm
đường dẫn rõ ràng:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Ghi chú:

- Đường dẫn có thể là tuyệt đối hoặc tương đối theo workspace.
- Thư mục được quét đệ quy cho các tệp `.md`.
- Chỉ lập chỉ mục tệp Markdown.
- Bỏ qua symlink (tệp hoặc thư mục).

### Gemini embeddings (native)

Đặt nhà cung cấp là `gemini` để dùng trực tiếp API embedding của Gemini:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Ghi chú:

- `remote.baseUrl` là tùy chọn (mặc định là base URL của Gemini API).
- `remote.headers` cho phép thêm header bổ sung nếu cần.
- Model mặc định: `gemini-embedding-001`.

Nếu bạn muốn dùng **endpoint tương thích OpenAI tùy chỉnh** (OpenRouter, vLLM, hoặc proxy),
bạn có thể dùng cấu hình `remote` với nhà cung cấp OpenAI:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Nếu bạn không muốn đặt khóa API, dùng `memorySearch.provider = "local"` hoặc đặt
`memorySearch.fallback = "none"`.

Fallback:

- `memorySearch.fallback` có thể là `openai`, `gemini`, `local`, hoặc `none`.
- Nhà cung cấp fallback chỉ được dùng khi nhà cung cấp embedding chính thất bại.

Lập chỉ mục theo lô (OpenAI + Gemini):

- 43. Được bật theo mặc định cho embeddings OpenAI và Gemini. 32. Đặt `agents.defaults.memorySearch.remote.batch.enabled = false` để vô hiệu hóa.
- Hành vi mặc định chờ hoàn tất batch; tinh chỉnh `remote.batch.wait`, `remote.batch.pollIntervalMs`, và `remote.batch.timeoutMinutes` nếu cần.
- Đặt `remote.batch.concurrency` để điều khiển số job batch gửi song song (mặc định: 2).
- Chế độ batch áp dụng khi `memorySearch.provider = "openai"` hoặc `"gemini"` và dùng khóa API tương ứng.
- Batch Gemini dùng endpoint batch embedding async và yêu cầu Gemini Batch API khả dụng.

Vì sao batch OpenAI nhanh + rẻ:

- Với backfill lớn, OpenAI thường là lựa chọn nhanh nhất chúng tôi hỗ trợ vì có thể gửi nhiều yêu cầu embedding trong một job batch và để OpenAI xử lý bất đồng bộ.
- OpenAI cung cấp giá ưu đãi cho workload Batch API, nên các đợt lập chỉ mục lớn thường rẻ hơn so với gửi đồng bộ cùng lượng yêu cầu.
- Xem tài liệu và bảng giá OpenAI Batch API để biết chi tiết:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Ví dụ cấu hình:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Công cụ:

- `memory_search` — trả về snippet kèm tệp + khoảng dòng.
- `memory_get` — đọc nội dung tệp bộ nhớ theo đường dẫn.

Chế độ local:

- Đặt `agents.defaults.memorySearch.provider = "local"`.
- Cung cấp `agents.defaults.memorySearch.local.modelPath` (GGUF hoặc URI `hf:`).
- Tùy chọn: đặt `agents.defaults.memorySearch.fallback = "none"` để tránh fallback từ xa.

### Cách các công cụ bộ nhớ hoạt động

- 33. `memory_search` tìm kiếm ngữ nghĩa các khối Markdown (~400 token mục tiêu, chồng lấp 80 token) từ `MEMORY.md` + `memory/**/*.md`. 44. Nó trả về đoạn trích văn bản (giới hạn ~700 ký tự), đường dẫn tệp, phạm vi dòng, điểm số, nhà cung cấp/mô hình, và liệu có fallback từ embeddings local → remote hay không. No full file payload is returned.
- 36. `memory_get` đọc một tệp Markdown bộ nhớ cụ thể (tương đối workspace), tùy chọn từ một dòng bắt đầu và trong N dòng. 37. Các đường dẫn ngoài `MEMORY.md` / `memory/` sẽ bị từ chối.
- Cả hai công cụ chỉ được bật khi `memorySearch.enabled` phân giải true cho tác tử.

### Những gì được lập chỉ mục (và khi nào)

- Loại tệp: chỉ Markdown (`MEMORY.md`, `memory/**/*.md`).
- Lưu trữ chỉ mục: SQLite theo từng tác tử tại `~/.openclaw/memory/<agentId>.sqlite` (cấu hình qua `agents.defaults.memorySearch.store.path`, hỗ trợ token `{agentId}`).
- 38. Độ mới: watcher trên `MEMORY.md` + `memory/` đánh dấu chỉ mục là bẩn (debounce 1,5s). Sync is scheduled on session start, on search, or on an interval and runs asynchronously. Session transcripts use delta thresholds to trigger background sync.
- 41. Kích hoạt lập chỉ mục lại: chỉ mục lưu trữ **nhà cung cấp/mô hình embedding + dấu vân tay endpoint + tham số chia khối**. 48. Nếu bất kỳ điều nào trong số đó thay đổi, OpenClaw tự động reset và lập chỉ mục lại toàn bộ kho.

### Hybrid search (BM25 + vector)

Khi bật, OpenClaw kết hợp:

- **Độ tương đồng vector** (khớp ngữ nghĩa, cách diễn đạt có thể khác)
- **Độ liên quan từ khóa BM25** (token chính xác như ID, biến môi trường, ký hiệu code)

Nếu tìm kiếm toàn văn không khả dụng trên nền tảng của bạn, OpenClaw fallback sang tìm kiếm chỉ vector.

#### Vì sao hybrid?

Tìm kiếm vector rất tốt cho “ý nghĩa tương đương”:

- “Mac Studio gateway host” vs “máy chạy gateway”
- “debounce cập nhật tệp” vs “tránh lập chỉ mục mỗi lần ghi”

Nhưng nó có thể yếu với token chính xác, tín hiệu cao:

- ID (`a828e60`, `b3b9895a…`)
- ký hiệu code (`memorySearch.query.hybrid`)
- chuỗi lỗi (“sqlite-vec unavailable”)

BM25 (full-text) is the opposite: strong at exact tokens, weaker at paraphrases.
50. Tìm kiếm lai là phương án trung dung thực dụng: **sử dụng cả hai tín hiệu truy xuất** để bạn có kết quả tốt cho cả truy vấn “ngôn ngữ tự nhiên” và truy vấn “kim đáy bể”.

#### Cách chúng tôi gộp kết quả (thiết kế hiện tại)

Phác thảo triển khai:

1. Lấy tập ứng viên từ cả hai phía:

- **Vector**: top `maxResults * candidateMultiplier` theo cosine similarity.
- **BM25**: top `maxResults * candidateMultiplier` theo thứ hạng FTS5 BM25 (thấp hơn là tốt hơn).

2. Chuyển thứ hạng BM25 thành điểm 0..1-ish:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Hợp nhất ứng viên theo id khối và tính điểm có trọng số:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Ghi chú:

- `vectorWeight` + `textWeight` được chuẩn hóa thành 1.0 khi phân giải cấu hình, nên trọng số hoạt động như phần trăm.
- Nếu embedding không khả dụng (hoặc nhà cung cấp trả về vector rỗng), chúng tôi vẫn chạy BM25 và trả kết quả khớp từ khóa.
- Nếu không thể tạo FTS5, chúng tôi giữ tìm kiếm chỉ vector (không lỗi cứng).

45. Điều này không phải là “hoàn hảo theo lý thuyết IR”, nhưng nó đơn giản, nhanh và thường cải thiện recall/precision trên ghi chú thực tế.
    If we want to get fancier later, common next steps are Reciprocal Rank Fusion (RRF) or score normalization
    (min/max or z-score) before mixing.

Cấu hình:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Embedding cache

OpenClaw có thể cache **embedding theo khối** trong SQLite để việc lập chỉ mục lại và cập nhật thường xuyên
(đặc biệt là transcript phiên) không phải embed lại văn bản không đổi.

Cấu hình:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Session memory search (experimental)

47. Bạn có thể tùy chọn lập chỉ mục **bản ghi phiên** và hiển thị chúng qua `memory_search`.
    This is gated behind an experimental flag.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Ghi chú:

- Lập chỉ mục phiên là **tùy chọn** (tắt theo mặc định).
- Cập nhật phiên được debounce và **lập chỉ mục bất đồng bộ** khi vượt ngưỡng delta (best-effort).
- `memory_search` không bao giờ chặn chờ lập chỉ mục; kết quả có thể hơi cũ cho đến khi đồng bộ nền hoàn tất.
- Kết quả vẫn chỉ gồm snippet; `memory_get` vẫn giới hạn ở tệp bộ nhớ.
- Lập chỉ mục phiên được cô lập theo từng tác tử (chỉ log phiên của tác tử đó được lập chỉ mục).
- Session logs live on disk (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). 50. Bất kỳ tiến trình/người dùng nào có quyền truy cập hệ thống tệp đều có thể đọc chúng, vì vậy hãy coi quyền truy cập đĩa là ranh giới tin cậy. For stricter isolation, run agents under separate OS users or hosts.

Ngưỡng delta (mặc định hiển thị):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite vector acceleration (sqlite-vec)

Khi tiện ích mở rộng sqlite-vec khả dụng, OpenClaw lưu trữ embedding trong một
bảng ảo SQLite (`vec0`) và thực hiện các truy vấn khoảng cách vector ngay trong
cơ sở dữ liệu. This keeps search fast without loading every embedding into JS.

Cấu hình (tùy chọn):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Ghi chú:

- `enabled` mặc định true; khi tắt, tìm kiếm fallback sang
  cosine similarity trong tiến trình trên embedding đã lưu.
- Nếu extension sqlite-vec thiếu hoặc không tải được, OpenClaw ghi log lỗi
  và tiếp tục với fallback JS (không có bảng vector).
- `extensionPath` ghi đè đường dẫn sqlite-vec đi kèm (hữu ích cho bản dựng tùy chỉnh
  hoặc vị trí cài đặt không chuẩn).

### Local embedding auto-download

- Model embedding local mặc định: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- When `memorySearch.provider = "local"`, `node-llama-cpp` resolves `modelPath`; if the GGUF is missing it **auto-downloads** to the cache (or `local.modelCacheDir` if set), then loads it. Downloads resume on retry.
- Yêu cầu build native: chạy `pnpm approve-builds`, chọn `node-llama-cpp`, rồi `pnpm rebuild node-llama-cpp`.
- Fallback: nếu thiết lập local thất bại và `memorySearch.fallback = "openai"`, chúng tôi tự động chuyển sang embedding từ xa
  (`openai/text-embedding-3-small` trừ khi bị ghi đè) và ghi lại lý do.

### Ví dụ endpoint tương thích OpenAI tùy chỉnh

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Ghi chú:

- `remote.*` có ưu tiên cao hơn `models.providers.openai.*`.
- `remote.headers` được hợp nhất với header của OpenAI; remote sẽ thắng khi trùng khóa. Omit `remote.headers` to use the OpenAI defaults.
