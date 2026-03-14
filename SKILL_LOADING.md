# OpenClaw Skill 加载优先级与策略文档

> 本文档面向开发者，描述 Skill 系统的加载来源、合并优先级、过滤逻辑、Prompt 注入限制，以及超出限制时的处理策略。
>
> 核心实现文件：`src/agents/skills/workspace.ts`

---

## 一、Skill 的来源与加载顺序

每次 Agent 运行时，`loadSkillEntries()` 会从以下 **6 个来源** 按顺序加载 Skill，并合并到一个以 skill 名称为 key 的 `Map`：

| 顺序 | 来源标识                 | 路径                                            | 说明                                   |
| ---- | ------------------------ | ----------------------------------------------- | -------------------------------------- |
| 1    | `openclaw-extra`         | `config.skills.load.extraDirs[]` + 插件注册目录 | 用户自定义扩展目录、插件贡献的 skill   |
| 2    | `openclaw-bundled`       | 内置 bundled skills 目录                        | OpenClaw 随包附带的内置 skill          |
| 3    | `openclaw-managed`       | `~/.openclaw/skills/`                           | `openclaw skills install` 安装的 skill |
| 4    | `agents-skills-personal` | `~/.agents/skills/`                             | 用户个人 `.agents/skills/` 目录        |
| 5    | `agents-skills-project`  | `<workspaceDir>/.agents/skills/`                | 项目级 `.agents/skills/` 目录          |
| 6    | `openclaw-workspace`     | `<workspaceDir>/skills/`                        | 工作区 `skills/` 目录（最高优先级）    |

**合并规则**：同名 skill 以**后写入者覆盖前者**，因此优先级为：

```
workspace > .agents/project > .agents/personal > managed > bundled > extra
```

这意味着在 `workspaceDir/skills/` 下放一个与内置 skill 同名的 `SKILL.md`，会完全替换掉内置版本。

---

## 二、每个来源的加载上限

在合并之前，每个来源的加载受以下两层限制约束（通过 `resolveSkillsLimits()` 读取配置，可在 `openclaw.yml` 覆盖）：

```
默认值：
  maxCandidatesPerRoot:       300   每个根目录最多扫描的子目录数
  maxSkillsLoadedPerSource:   200   每个来源最多加载的 skill 数
  maxSkillFileBytes:       256,000  单个 SKILL.md 文件的最大字节数（约 250 KB）
```

### 加载流程细节

1. **嵌套根检测**：若 `dir/skills/*/SKILL.md` 存在，自动把 `dir/skills/` 识别为实际根目录（而非 `dir/`）。
2. **子目录扫描**：对根目录下的子目录排序后，逐个检查是否存在 `SKILL.md`。
3. **文件大小过滤**：单个 `SKILL.md` 超过 `maxSkillFileBytes` 的直接跳过并打 warn 日志。
4. **数量截断**：某来源加载数超过 `maxSkillsLoadedPerSource` 后停止加载，并按名称排序后取前 N 个。

---

## 三、过滤阶段（Eligibility Check）

合并完成后，`filterSkillEntries()` 对每个 skill 调用 `shouldIncludeSkill()` 进行资格检查，不满足条件的直接排除：

### 3.1 检查项

| 检查项                                       | 判断逻辑                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `config.skills.entries[key].enabled = false` | 被配置显式禁用，排除                                              |
| `config.skills.allowBundled` 白名单          | bundled skill 不在白名单内，排除                                  |
| `metadata.os`                                | skill 声明了 OS 限制，当前 OS 不匹配，排除                        |
| `metadata.requires.env[]`                    | skill 要求的环境变量不存在（或未在 skillConfig.env 中配置），排除 |
| `metadata.requires.bin[]`                    | skill 要求的二进制工具不在 PATH，排除                             |
| `metadata.always = true`                     | 忽略所有其他条件，强制包含                                        |

### 3.2 skillFilter（精确指定）

如果调用方传入了 `skillFilter: string[]`（如来自 session 配置），则只保留名称在列表内的 skill，其他全部过滤。

---

## 四、Prompt 注入阶段：超出限制时的处理

通过过滤的 skill 进入 `applySkillsPromptLimits()`，在注入 system prompt 前进行最终截断：

```
默认值：
  maxSkillsInPrompt:      150   最多注入 prompt 的 skill 数量
  maxSkillsPromptChars: 30,000  skill 块的最大字符数
```

### 4.1 截断策略（两级）

```
第一级：数量截断
  直接 slice(0, maxSkillsInPrompt)
  截断原因标记为 "count"

第二级：字符截断（在数量截断结果上再截）
  用二分查找找到最大能塞进 maxSkillsPromptChars 的前缀长度
  截断原因标记为 "chars"
```

注意：**截断是按 Map 迭代顺序（即插入顺序）取前缀**，没有相关性排序。如果来源 1（extra/bundled）的 skill 很多，会先占满配额，后来的 workspace skill 可能被截掉。

### 4.2 截断时的用户提示

发生截断时，在 skill 块顶部插入警告：

```
⚠️ Skills truncated: included X of Y. Run `openclaw skills check` to audit.
```

超出限制的 skill **直接丢弃**，不以任何形式（摘要、路径索引等）出现在 prompt 中。

### 4.3 `disableModelInvocation` 的过滤

在数量/字符截断之前，还会过滤掉 frontmatter 中声明了 `disable-model-invocation: true` 的 skill。这类 skill 不注入 prompt，但仍参与 command slash 命令注册（`buildWorkspaceSkillCommandSpecs` 中）。

---

## 五、Prompt 内容优化

注入前还有一个 token 优化步骤（`compactSkillPaths()`）：

- 将 skill 文件路径中的 `$HOME/` 替换为 `~/`
- 每个 skill 路径节省约 5–6 个 token
- 100 个 skill 约节省 500–600 token

---

## 六、运行时决策路径（`resolveSkillsPromptForRun`）

```
resolveSkillsPromptForRun(params)
├── params.skillsSnapshot?.prompt 存在？
│   └── YES → 直接使用 snapshot 里预计算好的 prompt（跳过所有加载）
└── NO → params.entries 存在？
    ├── YES → buildWorkspaceSkillsPrompt(workspaceDir, { entries })
    │         ├── filterSkillEntries (eligibility check)
    │         ├── 过滤 disableModelInvocation
    │         ├── applySkillsPromptLimits (count + chars 双截断)
    │         └── formatSkillsForPrompt + compactSkillPaths
    └── NO → 返回 ""（不注入任何 skill）
```

**Snapshot 机制**：`buildWorkspaceSkillSnapshot()` 会在 session 启动阶段预先扫描并缓存整个 skill prompt。后续的同 session 运行直接用缓存，不重复扫描磁盘。

---

## 七、可配置参数（`openclaw.yml`）

```yaml
skills:
  # 禁用内置 bundled skills 白名单（空数组 = 全部允许）
  allowBundled:
    - github
    - docker

  # 针对单个 skill 的精细配置
  entries:
    my-skill:
      enabled: false # 禁用该 skill
      env:
        MY_API_KEY: "xxx" # 注入环境变量（用于 requires.env 检查）

  # 加载与 Prompt 的数量/大小限制
  limits:
    maxCandidatesPerRoot: 300 # 每个根目录最多扫描子目录数
    maxSkillsLoadedPerSource: 200 # 每个来源最多加载 skill 数
    maxSkillsInPrompt: 150 # 最多注入 prompt 的 skill 数
    maxSkillsPromptChars: 30000 # skill 块最大字符数
    maxSkillFileBytes: 256000 # 单个 SKILL.md 最大字节数

  # 额外加载目录（追加到 extra 来源）
  load:
    extraDirs:
      - ~/my-shared-skills
```

---

## 八、已知问题与改进方向

### 问题 1：截断无优先级排序

当前截断是按 Map 插入顺序（来源加载顺序）取前缀，**不按相关性、使用频率或来源重要性排序**。

**影响**：extra/bundled 来源的 skill 先插入 Map，若数量多会挤占 workspace skill 的位置，而 workspace skill 通常更具体也更重要。

**建议**：截断前按来源优先级重新排序，使 `workspace > .agents/project > ...` 的 skill 更不容易被截掉。

### 问题 2：被截断的 skill 完全不可见

超出限制的 skill 对模型完全不可见，模型无法知道"还有哪些 skill 存在但未加载"。

**建议**：在截断提示中附上被截掉的 skill 名称列表，或提供一个轻量索引（名称 + 一行描述 + 路径），让模型可以通过 `Read` 工具按需加载。

### 问题 3：snapshot 机制绑定 session 启动时的文件系统状态

Snapshot 在 session 开始时扫描一次并固化，session 期间修改的 skill 文件对当前 session 不可见。

---

_最后更新：2026-03-09_
