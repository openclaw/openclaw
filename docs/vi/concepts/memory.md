---
summary: "Cách bộ nhớ OpenClaw hoạt động (tệp workspace + xả bộ nhớ tự động)"
read_when:
  - Bạn muốn biết bố cục tệp bộ nhớ và quy trình làm việc
  - Bạn muốn tinh chỉnh cơ chế xả bộ nhớ tự động trước khi nén
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:19Z
---

# Memory

Bộ nhớ OpenClaw là **Markdown thuần trong workspace của tác tử**. Các tệp là
nguồn sự thật; mô hình chỉ “ghi nhớ” những gì được ghi ra đĩa.

Các công cụ tìm kiếm bộ nhớ được cung cấp bởi plugin bộ nhớ đang hoạt động (mặc định:
`memory-core`). Vô hiệu hóa plugin bộ nhớ bằng `plugins.slots.memory = "none"`.

## Memory files (Markdown)

Bố cục workspace mặc định dùng hai lớp bộ nhớ:

- `memory/YYYY-MM-DD.md`
  - Nhật ký hằng ngày (chỉ ghi thêm).
  - Đọc hôm nay + hôm qua khi bắt đầu phiên.
- `MEMORY.md` (tùy chọn)
  - Bộ nhớ dài hạn đã được tuyển chọn.
  - **Chỉ tải trong phiên chính, riêng tư** (không bao giờ trong ngữ cảnh nhóm).

Các tệp này nằm dưới workspace (`agents.defaults.workspace`, mặc định
`~/.openclaw/workspace`). Xem [Agent workspace](/concepts/agent-workspace) để biết bố cục đầy đủ.

## Khi nào ghi bộ nhớ

- Quyết định, sở thích và sự thật bền vững ghi vào `MEMORY.md`.
- Ghi chú hằng ngày và ngữ cảnh đang chạy ghi vào `memory/YYYY-MM-DD.md`.
- Nếu ai đó nói “hãy nhớ điều này”, hãy ghi lại (đừng giữ trong RAM).
- Khu vực này vẫn đang phát triển. Việc nhắc mô hình lưu bộ nhớ sẽ hữu ích; nó sẽ biết phải làm gì.
- Nếu bạn muốn điều gì đó được ghi nhớ, **hãy yêu cầu bot ghi vào bộ nhớ**.

## Automatic memory flush (pre-compaction ping)

Khi một phiên **gần đến ngưỡng tự động nén**, OpenClaw kích hoạt một **lượt tác tử im lặng**
để nhắc mô hình ghi bộ nhớ bền vững **trước khi** ngữ cảnh bị nén. Lời nhắc mặc định nói rõ mô hình _có thể trả lời_,
nhưng thường thì `NO_REPLY` là phản hồi đúng để người dùng không bao giờ thấy lượt này.

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
- Mặc định dùng embedding từ xa. Nếu `memorySearch.provider` chưa được đặt, OpenClaw tự động chọn:
  1. `local` nếu `memorySearch.local.modelPath` được cấu hình và tệp tồn tại.
  2. `openai` nếu có thể phân giải khóa OpenAI.
  3. `gemini` nếu có thể phân giải khóa Gemini.
  4. `voyage` nếu có thể phân giải khóa Voyage.
  5. Nếu không, tìm kiếm bộ nhớ sẽ bị vô hiệu cho đến khi được cấu hình.
- Chế độ local dùng node-llama-cpp và có thể cần `pnpm approve-builds`.
- Dùng sqlite-vec (khi có) để tăng tốc tìm kiếm vector trong SQLite.

Embedding từ xa **yêu cầu** khóa API của nhà cung cấp embedding. OpenClaw
phân giải khóa từ hồ sơ xác thực, `models.providers.*.apiKey`, hoặc biến môi trường.
Codex OAuth chỉ bao phủ chat/completions và **không** đáp ứng embedding cho tìm kiếm bộ nhớ.
Với Gemini, dùng `GEMINI_API_KEY` hoặc
`models.providers.google.apiKey`. Với Voyage, dùng `VOYAGE_API_KEY` hoặc
`models.providers.voyage.apiKey`. Khi dùng endpoint tương thích OpenAI tùy chỉnh,
đặt `memorySearch.remote.apiKey` (và tùy chọn `memorySearch.remote.headers`).

### QMD backend (experimental)

Đặt `memory.backend = "qmd"` để hoán đổi bộ lập chỉ mục SQLite tích hợp bằng
[QMD](https://github.com/tobi/qmd): một sidecar tìm kiếm ưu tiên local kết hợp
BM25 + vector + xếp hạng lại. Markdown vẫn là nguồn sự thật; OpenClaw gọi QMD
để truy xuất. Các điểm chính:

**Prereqs**

- Mặc định tắt. Chọn tham gia theo từng cấu hình (`memory.backend = "qmd"`).
- Cài QMD CLI riêng (`bun install -g https://github.com/tobi/qmd` hoặc tải
  bản phát hành) và đảm bảo binary `qmd` nằm trong `PATH` của gateway.
- QMD cần bản dựng SQLite cho phép extension (`brew install sqlite` trên
  macOS).
- QMD chạy hoàn toàn local qua Bun + `node-llama-cpp` và tự động tải model GGUF
  từ HuggingFace khi dùng lần đầu (không cần daemon Ollama riêng).
- Gateway chạy QMD trong một XDG home tự chứa dưới
  `~/.openclaw/agents/<agentId>/qmd/` bằng cách đặt `XDG_CONFIG_HOME` và
  `XDG_CACHE_HOME`.
- Hỗ trợ hệ điều hành: macOS và Linux hoạt động ngay khi cài Bun + SQLite.
  Windows được hỗ trợ tốt nhất qua WSL2.

**Cách sidecar chạy**

- Gateway ghi một QMD home tự chứa dưới
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + sqlite DB).
- Collection được tạo qua `qmd collection add` từ `memory.qmd.paths`
  (cộng với các tệp bộ nhớ workspace mặc định), sau đó `qmd update` + `qmd embed` chạy
  khi khởi động và theo khoảng thời gian cấu hình (`memory.qmd.update.interval`,
  mặc định 5 phút).
- Làm mới khi khởi động hiện chạy nền theo mặc định để không chặn khởi động chat;
  đặt `memory.qmd.update.waitForBootSync = true` để giữ hành vi chặn trước đây.
- Tìm kiếm chạy qua `qmd query --json`. Nếu QMD lỗi hoặc thiếu binary,
  OpenClaw tự động quay về trình quản lý SQLite tích hợp để các công cụ bộ nhớ
  vẫn hoạt động.
- Hiện OpenClaw không phơi bày tinh chỉnh batch-size embedding của QMD; hành vi batch
  do QMD tự điều khiển.
- **Lần tìm đầu tiên có thể chậm**: QMD có thể tải model GGUF local (reranker/mở rộng truy vấn)
  ở lần chạy `qmd query` đầu tiên.
  - OpenClaw tự động đặt `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` khi chạy QMD.
  - Nếu muốn tải sẵn model thủ công (và làm ấm cùng chỉ mục OpenClaw dùng),
    hãy chạy một truy vấn một lần với các XDG dir của tác tử.

    Trạng thái QMD của OpenClaw nằm dưới **state dir** của bạn (mặc định `~/.openclaw`).
    Bạn có thể trỏ `qmd` tới đúng cùng chỉ mục bằng cách export cùng biến XDG
    mà OpenClaw dùng:

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
- `scope`: cùng schema với [`session.sendPolicy`](/gateway/configuration#session).
  Mặc định chỉ DM (`deny` tất cả, `allow` chat trực tiếp); nới lỏng để hiển thị
  kết quả QMD trong nhóm/kênh.
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
- Khi `qmd` chạy, chúng tôi gắn thẻ `status().backend = "qmd"` để chẩn đoán hiển thị
  engine nào phục vụ kết quả. Nếu subprocess QMD thoát hoặc không thể phân tích
  đầu ra JSON, trình quản lý tìm kiếm ghi cảnh báo và trả về nhà cung cấp tích hợp
  (embedding Markdown hiện có) cho đến khi QMD phục hồi.

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

- Bật theo mặc định cho embedding OpenAI và Gemini. Đặt `agents.defaults.memorySearch.remote.batch.enabled = false` để tắt.
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

- `memory_search` tìm kiếm ngữ nghĩa các khối Markdown (~400 token mục tiêu, chồng lấp 80 token) từ `MEMORY.md` + `memory/**/*.md`. Nó trả về văn bản snippet (giới hạn ~700 ký tự), đường dẫn tệp, khoảng dòng, điểm số, nhà cung cấp/model, và liệu có fallback từ local → remote embedding hay không. Không trả payload toàn bộ tệp.
- `memory_get` đọc một tệp Markdown bộ nhớ cụ thể (tương đối theo workspace), tùy chọn từ dòng bắt đầu và trong N dòng. Đường dẫn ngoài `MEMORY.md` / `memory/` sẽ bị từ chối.
- Cả hai công cụ chỉ được bật khi `memorySearch.enabled` phân giải true cho tác tử.

### Những gì được lập chỉ mục (và khi nào)

- Loại tệp: chỉ Markdown (`MEMORY.md`, `memory/**/*.md`).
- Lưu trữ chỉ mục: SQLite theo từng tác tử tại `~/.openclaw/memory/<agentId>.sqlite` (cấu hình qua `agents.defaults.memorySearch.store.path`, hỗ trợ token `{agentId}`).
- Độ mới: watcher trên `MEMORY.md` + `memory/` đánh dấu chỉ mục là bẩn (debounce 1,5s). Đồng bộ được lên lịch khi bắt đầu phiên, khi tìm kiếm, hoặc theo khoảng thời gian và chạy bất đồng bộ. Transcript phiên dùng ngưỡng delta để kích hoạt đồng bộ nền.
- Kích hoạt lập chỉ mục lại: chỉ mục lưu **nhà cung cấp/model embedding + fingerprint endpoint + tham số chia khối**. Nếu bất kỳ thay đổi nào, OpenClaw tự động reset và lập chỉ mục lại toàn bộ kho.

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

BM25 (toàn văn) thì ngược lại: mạnh ở token chính xác, yếu ở diễn đạt lại.
Hybrid search là điểm cân bằng thực dụng: **dùng cả hai tín hiệu truy xuất** để có
kết quả tốt cho cả truy vấn “ngôn ngữ tự nhiên” và “tìm kim đáy bể”.

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

Điều này không “hoàn hảo theo lý thuyết IR”, nhưng đơn giản, nhanh, và thường cải thiện recall/precision trên ghi chú thực tế.
Nếu muốn nâng cao sau này, các bước tiếp theo phổ biến là Reciprocal Rank Fusion (RRF) hoặc chuẩn hóa điểm
(min/max hoặc z-score) trước khi trộn.

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

Bạn có thể tùy chọn lập chỉ mục **transcript phiên** và hiển thị chúng qua `memory_search`.
Tính năng này được che chắn sau một cờ experimental.

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
- Log phiên nằm trên đĩa (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Bất kỳ tiến trình/người dùng nào có quyền truy cập filesystem đều có thể đọc, vì vậy hãy coi truy cập đĩa là ranh giới tin cậy. Để cô lập chặt chẽ hơn, chạy tác tử dưới các người dùng OS hoặc máy chủ riêng.

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

Khi extension sqlite-vec khả dụng, OpenClaw lưu embedding trong
bảng ảo SQLite (`vec0`) và thực hiện truy vấn khoảng cách vector ngay trong
cơ sở dữ liệu. Điều này giữ tìm kiếm nhanh mà không cần nạp mọi embedding vào JS.

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
- Khi `memorySearch.provider = "local"`, `node-llama-cpp` phân giải `modelPath`; nếu thiếu GGUF nó sẽ **tự động tải**
  về cache (hoặc `local.modelCacheDir` nếu đặt), rồi nạp. Tải xuống tiếp tục khi thử lại.
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
- `remote.headers` hợp nhất với header OpenAI; phía remote thắng khi xung đột khóa. Bỏ `remote.headers` để dùng mặc định OpenAI.
