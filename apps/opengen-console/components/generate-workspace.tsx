"use client";

import { FormEvent, useMemo, useState } from "react";

type GenerationType = "web" | "api" | "mobile" | "desktop" | "cli";

interface ProductSpecUserStory {
  as: string;
  i_want: string;
  so_that: string;
  acceptance_criteria?: string[];
}

interface ProductSpecFeature {
  name: string;
  priority: "high" | "medium" | "low";
  description: string;
}

interface ProductSpec {
  user_stories: ProductSpecUserStory[];
  features: ProductSpecFeature[];
  non_functional_requirements: Record<string, string | undefined>;
}

interface GenerationResult {
  task_id?: string;
  status?: string;
  outputs?: {
    product_spec?: ProductSpec;
  };
  error?: string;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

const typeOptions: GenerationType[] = ["web", "api", "mobile", "desktop", "cli"];

function priorityLabel(priority: ProductSpecFeature["priority"]): string {
  if (priority === "high") return "高";
  if (priority === "medium") return "中";
  return "低";
}

export function GenerateWorkspace() {
  const [description, setDescription] = useState("");
  const [type, setType] = useState<GenerationType>("web");
  const [techStackInput, setTechStackInput] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const productSpec = useMemo(() => result?.outputs?.product_spec, [result]);
  const storyCount = productSpec?.user_stories?.length ?? 0;
  const featureCount = productSpec?.features?.length ?? 0;
  const nfrCount = productSpec?.non_functional_requirements
    ? Object.keys(productSpec.non_functional_requirements).length
    : 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitState("submitting");
    setErrorMessage("");

    try {
      const tech_stack = techStackInput
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          type,
          tech_stack: tech_stack.length > 0 ? tech_stack : undefined,
        }),
      });

      const data = (await response.json()) as GenerationResult;
      if (!response.ok) {
        throw new Error(data.error || "Generation request failed");
      }

      setResult(data);
      setSubmitState("success");
    } catch (error) {
      setSubmitState("error");
      setErrorMessage(error instanceof Error ? error.message : "Unknown error");
    }
  }

  return (
    <div className="generate-workspace">
      <form className="generate-form" onSubmit={onSubmit}>
        <label htmlFor="description">需求描述</label>
        <textarea
          id="description"
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="例如：做一个支持多用户协作的 todo app"
          required
        />

          <label htmlFor="type">应用类型</label>
          <select id="type" value={type} onChange={(event) => setType(event.target.value as GenerationType)}>
            {typeOptions.map((option) => (
              <option key={option} value={option}>
                {{
                  web: "Web 应用",
                  api: "API 服务",
                  mobile: "移动应用",
                  desktop: "桌面应用",
                  cli: "命令行工具",
                }[option]}
              </option>
            ))}
          </select>

        <label htmlFor="tech-stack">技术栈（可选，逗号分隔）</label>
        <input
          id="tech-stack"
          type="text"
          value={techStackInput}
          onChange={(event) => setTechStackInput(event.target.value)}
          placeholder="nextjs, typescript, sqlite"
        />

        <button type="submit" disabled={submitState === "submitting"}>
          {submitState === "submitting" ? "生成中..." : "开始生成"}
        </button>
      </form>

      {submitState === "error" ? <p className="result-error">{errorMessage}</p> : null}

      {productSpec ? (
        <section className="result-panel" aria-label="生成结果">
          <h2>结果概览</h2>
          <div className="summary-grid">
            <div>
              <strong>{storyCount}</strong>
              <span>故事数量</span>
            </div>
            <div>
              <strong>{featureCount}</strong>
              <span>功能数量</span>
            </div>
            <div>
              <strong>{nfrCount}</strong>
              <span>NFR 数量</span>
            </div>
          </div>

          <h3>用户故事</h3>
          <ul>
            {productSpec.user_stories.map((story, index) => (
              <li key={`${story.as}-${index}`}>
                <strong>作为：</strong>
                {story.as} <strong>我想要：</strong>
                {story.i_want} <strong>以便：</strong>
                {story.so_that}
              </li>
            ))}
          </ul>

          <h3>功能清单</h3>
          <ul>
            {productSpec.features.map((feature) => (
              <li key={feature.name}>
                <span className={`priority-tag priority-${feature.priority}`}>
                  {priorityLabel(feature.priority)}
                </span>{" "}
                <strong>{feature.name}</strong> {feature.description}
              </li>
            ))}
          </ul>

          <h3>非功能需求</h3>
          <ul>
            {Object.entries(productSpec.non_functional_requirements).map(([key, value]) => (
              <li key={key}>
                <strong>{key}:</strong> {value ?? "暂无"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
