#!/bin/bash
set -e

echo "Installing Node Exporter for system metrics..."

# Download and install node_exporter
NODE_EXPORTER_VERSION="1.8.2"
ARCH="linux-amd64"

cd /tmp
wget -q "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.${ARCH}.tar.gz"

tar xzf "node_exporter-${NODE_EXPORTER_VERSION}.${ARCH}.tar.gz"
sudo cp "node_exporter-${NODE_EXPORTER_VERSION}.${ARCH}/node_exporter" /usr/local/bin/
sudo chown root:root /usr/local/bin/node_exporter
sudo chmod +x /usr/local/bin/node_exporter

# Create systemd service
sudo tee /etc/systemd/system/node_exporter.service > /dev/null << 'EOF'
[Unit]
Description=Prometheus Node Exporter
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
ExecStart=/usr/local/bin/node_exporter \
    --web.listen-address=:9100 \
    --path.procfs=/proc \
    --path.sysfs=/sys \
    --collector.filesystem.mount-points-exclude="^/(sys|proc|dev|host|etc|rootfs/var/lib/docker/containers|rootfs/var/lib/docker/overlay2|rootfs/run/docker/netns|rootfs/var/lib/docker/aufs)($$|/)"
    
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Start and enable
sudo systemctl daemon-reload
sudo systemctl enable node_exporter.service
sudo systemctl start node_exporter.service

# Update OTEL collector config to scrape node_exporter
sudo tee -a /etc/otel-collector-config.yaml > /dev/null << 'EOF'

  prometheus:
    config:
      scrape_configs:
        - job_name: 'node-exporter'
          static_configs:
            - targets: ['localhost:9100']
          scrape_interval: 15s
EOF

# Restart OTEL collector to pick up new config
sudo systemctl restart otel-collector.service

echo "✅ Node Exporter installed and configured"
echo "🔗 Metrics available at: http://localhost:9100/metrics"
echo "📊 Will be scraped by OTEL Collector and exported to Prometheus"

# Cleanup
rm -rf /tmp/node_exporter-*

echo "System metrics now available in Grafana!"