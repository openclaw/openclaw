'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-TW">
      <body>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          fontFamily: 'system-ui, sans-serif'
        }}>
          <div style={{ maxWidth: '32rem', width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>😵</div>
            <h1 style={{ fontSize: '2rem', fontWeight: 'bold', marginBottom: '1rem' }}>
              糟糕！出錯了
            </h1>
            <p style={{ color: '#666', marginBottom: '2rem' }}>
              我們遇到了一個預期之外的錯誤。別擔心，這不是你的問題。
            </p>
            {error.digest && (
              <p style={{ fontSize: '0.75rem', color: '#999', fontFamily: 'monospace', marginBottom: '2rem' }}>
                錯誤 ID: {error.digest}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: '#f97316',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontSize: '1rem',
                marginRight: '1rem'
              }}
            >
              重試一次
            </button>
            <a
              href="/"
              style={{
                padding: '0.75rem 1.5rem',
                border: '1px solid #ccc',
                borderRadius: '0.5rem',
                textDecoration: 'none',
                color: 'inherit',
                display: 'inline-block'
              }}
            >
              返回首頁
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
