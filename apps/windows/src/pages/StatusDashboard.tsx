export default function StatusDashboard() {
  return (
    <div>
      <h1 className="page-header">Status</h1>
      <div className="placeholder-card">
        <p className="page-description">
          Gateway connection status, channel health, and system overview will
          appear here. Connects to the local gateway via WebSocket to display
          real-time status.
        </p>
      </div>
    </div>
  );
}
