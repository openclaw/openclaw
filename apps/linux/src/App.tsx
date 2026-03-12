import { useState, useEffect } from 'react';

function App() {
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<any[]>([]);

  useEffect(() => {
    // Check gateway connection on mount
  }, []);

  const handleConnect = async () => {
    setConnected(true);
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>OpenClaw - Linux</h1>
      
      <div style={{ marginBottom: '20px' }}>
        <button onClick={handleConnect}>
          {connected ? 'Connected' : 'Connect to Gateway'}
        </button>
      </div>

      <div>
        <h2>Paired Devices</h2>
        {devices.length === 0 ? (
          <p>No devices paired yet</p>
        ) : (
          <ul>
            {devices.map((device) => (
              <li key={device.id}>{device.name}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default App;
