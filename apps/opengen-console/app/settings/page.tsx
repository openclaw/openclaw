 "use client";

import { useEffect, useState } from "react";
import { ConsoleShell } from "../../components/console-shell";

interface SettingsDiagnostics {
  provider: string;
  model: string;
  endpoint_host: string;
  health_status: string;
  checked_at: number;
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/api/settings");
        const payload = (await response.json()) as SettingsDiagnostics & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "加载设置诊断失败");
        }
        setData(payload);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "未知错误");
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  const content = (() => {
    if (loading) {
      return <p>诊断信息加载中...</p>;
    }

    if (error) {
      return <p className="result-error">{error}</p>;
    }

    if (!data) {
      return <p>暂无诊断数据。</p>;
    }

    return (
      <div className="settings-grid">
        <div className="settings-card">
          <h3>Provider</h3>
          <p>{data.provider}</p>
        </div>
        <div className="settings-card">
          <h3>模型</h3>
          <p>{data.model}</p>
        </div>
        <div className="settings-card">
          <h3>端点主机</h3>
          <p>{data.endpoint_host}</p>
        </div>
        <div className="settings-card">
          <h3>健康状态</h3>
          <p>{data.health_status}</p>
        </div>
      </div>
    );
  })();

  return (
    <ConsoleShell title="设置">
      {content}
    </ConsoleShell>
  );
}
