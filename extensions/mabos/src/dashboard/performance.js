/**
 * MABOS Dashboard — Business Performance Dashboard
 */

(function () {
  var expandedCampaign = null;

  MABOS.renderPerformance = async function (container, businessId) {
    if (!businessId) {
      container.innerHTML =
        '<div class="empty-state"><h3>Select a business first</h3><p>Use the business switcher in the sidebar.</p></div>';
      return;
    }

    container.innerHTML = '<div class="loading">Loading performance data...</div>';

    // Fetch metrics, campaigns, and decisions in parallel
    var results = await Promise.all([
      MABOS.fetchJSON("/mabos/api/metrics/" + businessId),
      MABOS.fetchJSON("/mabos/api/businesses/" + businessId + "/campaigns"),
      MABOS.fetchJSON("/mabos/api/decisions"),
    ]);

    var metricsData = results[0];
    var campaignsData = results[1];
    var decisionsData = results[2];

    var metrics = (metricsData && metricsData.metrics) || {};
    var campaigns = (campaignsData && campaignsData.campaigns) || [];
    var decisions = (decisionsData && decisionsData.decisions) || [];
    var pendingDecisions = decisions.filter(function (d) {
      return d.business_id === businessId;
    });

    var html = '<div class="view-header"><h2>Performance Dashboard</h2></div>';

    // ── KPI Cards Row ──
    var revenue = metrics.revenue || metrics.total_revenue || 0;
    var expenses = metrics.expenses || metrics.total_expenses || 0;
    var margin = revenue > 0 ? (((revenue - expenses) / revenue) * 100).toFixed(1) : 0;
    var activeCampaigns = campaigns.filter(function (c) {
      return c.status === "active";
    }).length;

    html += '<div class="grid">';
    html += kpiCard("Revenue", formatCurrency(revenue), "var(--success-text)");
    html += kpiCard("Expenses", formatCurrency(expenses), "var(--danger-text)");
    html += kpiCard(
      "Margin",
      margin + "%",
      parseFloat(margin) >= 0 ? "var(--success-text)" : "var(--danger-text)",
    );
    html += kpiCard("Active Campaigns", activeCampaigns, "var(--accent)");
    html += kpiCard(
      "Pending Decisions",
      pendingDecisions.length,
      pendingDecisions.length > 0 ? "var(--warning)" : "var(--text-muted)",
    );
    html += "</div>";

    // ── Sales Performance (CSS Bar Chart) ──
    var snapshots = metrics.snapshots || [];
    if (snapshots.length > 0 || revenue > 0) {
      html += '<h3 class="section-header">Sales Performance</h3>';
      html += '<div class="card">';
      html += renderBarChart(snapshots, revenue);
      html += "</div>";
    }

    // ── Conversion Rate Sparkline ──
    if (snapshots.length > 2) {
      html += '<div class="card" style="margin-bottom:16px">';
      html += '<div class="card-header"><span class="card-title">Conversion Trend</span></div>';
      html += renderSparkline(
        snapshots.map(function (s) {
          return s.conversion_rate || 0;
        }),
      );
      html += "</div>";
    }

    // ── Marketing Campaigns Table ──
    html += '<h3 class="section-header">Marketing Campaigns</h3>';
    if (campaigns.length === 0) {
      html +=
        '<div class="card"><p style="color:var(--text-secondary);padding:12px">No campaigns found. Campaign data is stored in marketing.json.</p></div>';
    } else {
      html += '<div class="card"><table>';
      html +=
        "<tr><th>Campaign</th><th>Platform</th><th>Status</th><th>Budget</th><th>Impressions</th><th>Clicks</th><th>Conversions</th><th>ROAS</th></tr>";

      campaigns.forEach(function (c) {
        var m = c.metrics || {};
        var statusBadge =
          c.status === "active"
            ? "badge-active"
            : c.status === "proposed"
              ? "badge-pending"
              : "badge-low";
        var roas =
          m.roas || (m.spend > 0 ? (((m.conversions || 0) * 50) / m.spend).toFixed(2) : "-");
        var isExpanded = expandedCampaign === c.id;

        html +=
          '<tr class="campaign-row" data-campaign-id="' +
          (c.id || "") +
          '" style="cursor:pointer">';
        html += "<td><strong>" + MABOS.escapeHtml(c.name || c.id || "Unnamed") + "</strong></td>";
        html += "<td>" + MABOS.escapeHtml(c.platform || "-") + "</td>";
        html +=
          '<td><span class="badge ' + statusBadge + '">' + (c.status || "unknown") + "</span></td>";
        html += "<td>" + formatCurrency(c.budget || 0) + "</td>";
        html += "<td>" + formatNumber(m.impressions || 0) + "</td>";
        html += "<td>" + formatNumber(m.clicks || 0) + "</td>";
        html += "<td>" + formatNumber(m.conversions || 0) + "</td>";
        html += "<td>" + roas + "x</td>";
        html += "</tr>";

        if (isExpanded) {
          html += '<tr class="campaign-detail-row"><td colspan="8">';
          html += '<div class="campaign-detail">';
          html += '<div class="grid" style="grid-template-columns:repeat(3,1fr)">';
          if (c.objective)
            html += "<div><strong>Objective:</strong> " + MABOS.escapeHtml(c.objective) + "</div>";
          if (c.targeting)
            html +=
              "<div><strong>Targeting:</strong> " +
              MABOS.escapeHtml(
                typeof c.targeting === "string" ? c.targeting : JSON.stringify(c.targeting),
              ) +
              "</div>";
          if (m.spend !== undefined)
            html += "<div><strong>Spend:</strong> " + formatCurrency(m.spend) + "</div>";
          if (m.ctr !== undefined)
            html += "<div><strong>CTR:</strong> " + (m.ctr * 100).toFixed(2) + "%</div>";
          if (m.cpc !== undefined)
            html += "<div><strong>CPC:</strong> " + formatCurrency(m.cpc) + "</div>";
          if (c.confidence_score !== undefined)
            html +=
              "<div><strong>Confidence:</strong> " +
              (c.confidence_score * 100).toFixed(0) +
              "%</div>";
          html += "</div>";

          // Mini bar chart for campaign performance
          if (m.impressions > 0) {
            var ctrPct = (((m.clicks || 0) / m.impressions) * 100).toFixed(1);
            var convPct = (((m.conversions || 0) / Math.max(m.clicks || 1, 1)) * 100).toFixed(1);
            html += '<div style="margin-top:12px">';
            html += '<div style="display:flex;gap:16px">';
            html += miniBar("CTR", parseFloat(ctrPct), "var(--accent)");
            html += miniBar("Conv Rate", parseFloat(convPct), "var(--success-text)");
            html += "</div></div>";
          }

          html += "</div></td></tr>";
        }
      });

      html += "</table></div>";
    }

    container.innerHTML = html;

    // Bind campaign row clicks
    container.querySelectorAll(".campaign-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var id = row.dataset.campaignId;
        expandedCampaign = expandedCampaign === id ? null : id;
        MABOS.renderPerformance(container, businessId);
      });
    });
  };

  function kpiCard(label, value, color) {
    return (
      '<div class="card"><div class="stat" style="color:' +
      color +
      '">' +
      value +
      '</div><div class="stat-label">' +
      label +
      "</div></div>"
    );
  }

  function formatCurrency(val) {
    if (typeof val !== "number") return "$0";
    return (
      "$" + val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    );
  }

  function formatNumber(val) {
    if (typeof val !== "number") return "0";
    return val.toLocaleString();
  }

  function renderBarChart(snapshots, currentRevenue) {
    if (snapshots.length === 0 && currentRevenue > 0) {
      // Single bar for current revenue
      snapshots = [{ label: "Current", revenue: currentRevenue }];
    }
    if (snapshots.length === 0) return '<p style="color:var(--text-muted)">No data available</p>';

    var maxVal = Math.max.apply(
      null,
      snapshots.map(function (s) {
        return s.revenue || 0;
      }),
    );
    if (maxVal === 0) maxVal = 1;

    var html = '<div class="chart-bar-container">';
    snapshots.slice(-12).forEach(function (s) {
      var pct = (((s.revenue || 0) / maxVal) * 100).toFixed(1);
      html += '<div class="chart-bar-group">';
      html += '<div class="chart-bar" style="height:' + pct + '%"></div>';
      html += '<div class="chart-bar-label">' + (s.label || s.period || "") + "</div>";
      html += "</div>";
    });
    html += "</div>";
    return html;
  }

  function renderSparkline(values) {
    if (values.length < 2) return "";
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);
    var range = max - min || 1;
    var w = 200;
    var h = 40;
    var points = values.map(function (v, i) {
      var x = (i / (values.length - 1)) * w;
      var y = h - ((v - min) / range) * h;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return (
      '<svg class="sparkline" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" width="' +
      w +
      '" height="' +
      h +
      '"><path d="M' +
      points.join(" L") +
      '" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>'
    );
  }

  function miniBar(label, pct, color) {
    pct = Math.min(pct, 100);
    return (
      '<div style="flex:1"><div style="font-size:0.8em;color:var(--text-secondary);margin-bottom:4px">' +
      label +
      ": " +
      pct +
      "%</div>" +
      '<div style="background:var(--bg-tertiary);border-radius:4px;height:8px;overflow:hidden"><div style="width:' +
      pct +
      "%;background:" +
      color +
      ';height:100%;border-radius:4px"></div></div></div>'
    );
  }
})();
