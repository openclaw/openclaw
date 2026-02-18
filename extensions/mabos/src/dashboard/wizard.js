/**
 * MABOS Dashboard — 5-Step Business Onboarding Wizard
 */

(function () {
  let currentStep = 1;
  const totalSteps = 5;
  const wizardData = {};

  // ── Reusable Tag Input Component ──
  MABOS.createTagInput = function (container, tags, placeholder) {
    const wrapper = document.createElement("div");
    wrapper.className = "tag-input-wrapper";

    const tagContainer = document.createElement("div");
    tagContainer.className = "tag-container";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tag-input-field";
    input.placeholder = placeholder || "Type and press Enter...";

    function renderTags() {
      tagContainer.innerHTML = "";
      tags.forEach(function (tag, i) {
        const el = document.createElement("span");
        el.className = "tag";
        el.innerHTML =
          MABOS.escapeHtml(tag) +
          '<button class="tag-remove" data-idx="' +
          i +
          '">&times;</button>';
        tagContainer.appendChild(el);
      });
    }

    tagContainer.addEventListener("click", function (e) {
      if (e.target.classList.contains("tag-remove")) {
        var idx = parseInt(e.target.dataset.idx, 10);
        tags.splice(idx, 1);
        renderTags();
      }
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim()) {
        e.preventDefault();
        tags.push(input.value.trim());
        input.value = "";
        renderTags();
      }
    });

    wrapper.appendChild(tagContainer);
    wrapper.appendChild(input);
    container.appendChild(wrapper);
    renderTags();

    return {
      getTags: function () {
        return tags;
      },
      setTags: function (newTags) {
        tags.length = 0;
        tags.push.apply(tags, newTags);
        renderTags();
      },
    };
  };

  function slugify(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  MABOS.renderWizard = function (container) {
    wizardData.goals = [];
    wizardData.customer_segments = [];
    wizardData.value_propositions = [];
    wizardData.products_services = [];
    wizardData.revenue_streams = [];

    container.innerHTML =
      '<div class="wizard">' +
      '<div class="wizard-progress" id="wizard-progress"></div>' +
      '<div class="wizard-body" id="wizard-body"></div>' +
      '<div class="wizard-nav" id="wizard-nav"></div>' +
      "</div>";

    currentStep = 1;
    renderProgress();
    renderStep(currentStep);
    renderNav();
  };

  function renderProgress() {
    var html = "";
    for (var i = 1; i <= totalSteps; i++) {
      var cls = "wizard-step-indicator";
      if (i < currentStep) cls += " completed";
      if (i === currentStep) cls += " active";
      var labels = [
        "Basic Info",
        "Description & Goals",
        "Market & Customers",
        "Products & Revenue",
        "Review & Launch",
      ];
      html +=
        '<div class="' +
        cls +
        '"><span class="step-num">' +
        i +
        '</span><span class="step-label">' +
        labels[i - 1] +
        "</span></div>";
    }
    document.getElementById("wizard-progress").innerHTML = html;
  }

  function renderNav() {
    var html = '<div class="wizard-nav-inner">';
    if (currentStep > 1) {
      html += '<button class="btn btn-secondary" id="wizard-back">Back</button>';
    } else {
      html += "<span></span>";
    }
    if (currentStep < totalSteps) {
      html += '<button class="btn btn-primary" id="wizard-next">Next</button>';
    } else {
      html += '<button class="btn btn-primary" id="wizard-submit">Launch Business</button>';
    }
    html += "</div>";
    document.getElementById("wizard-nav").innerHTML = html;

    var backBtn = document.getElementById("wizard-back");
    var nextBtn = document.getElementById("wizard-next");
    var submitBtn = document.getElementById("wizard-submit");

    if (backBtn)
      backBtn.addEventListener("click", function () {
        saveCurrentStep();
        currentStep--;
        renderProgress();
        renderStep(currentStep);
        renderNav();
      });
    if (nextBtn)
      nextBtn.addEventListener("click", function () {
        if (validateStep()) {
          saveCurrentStep();
          currentStep++;
          renderProgress();
          renderStep(currentStep);
          renderNav();
        }
      });
    if (submitBtn) submitBtn.addEventListener("click", submitWizard);
  }

  function renderStep(step) {
    var body = document.getElementById("wizard-body");
    switch (step) {
      case 1:
        renderStep1(body);
        break;
      case 2:
        renderStep2(body);
        break;
      case 3:
        renderStep3(body);
        break;
      case 4:
        renderStep4(body);
        break;
      case 5:
        renderStep5(body);
        break;
    }
  }

  function renderStep1(body) {
    var typeOpts = MABOS.BUSINESS_TYPES.map(function (t) {
      var sel = wizardData.type === t.id ? " selected" : "";
      return '<option value="' + t.id + '"' + sel + ">" + t.label + "</option>";
    }).join("");
    var stageOpts = MABOS.BUSINESS_STAGES.map(function (s) {
      var sel = wizardData.stage === s.id ? " selected" : "";
      return '<option value="' + s.id + '"' + sel + ">" + s.label + "</option>";
    }).join("");
    var legalOpts = MABOS.LEGAL_STRUCTURES.map(function (l) {
      var sel = wizardData.legal_structure === l.id ? " selected" : "";
      return '<option value="' + l.id + '"' + sel + ">" + l.label + "</option>";
    }).join("");

    body.innerHTML =
      '<h3 class="wizard-step-title">Step 1: Basic Information</h3>' +
      '<div class="form-group"><label class="form-label">Business Name *</label>' +
      '<input type="text" class="form-input" id="wiz-name" value="' +
      MABOS.escapeHtml(wizardData.name || "") +
      '" placeholder="My Awesome Business"></div>' +
      '<div class="form-group"><label class="form-label">Legal Name</label>' +
      '<input type="text" class="form-input" id="wiz-legal-name" value="' +
      MABOS.escapeHtml(wizardData.legal_name || "") +
      '" placeholder="Legal entity name"></div>' +
      '<div class="form-row">' +
      '<div class="form-group"><label class="form-label">Industry *</label>' +
      '<select class="form-select" id="wiz-type"><option value="">Select industry...</option>' +
      typeOpts +
      "</select></div>" +
      '<div class="form-group"><label class="form-label">Stage</label>' +
      '<select class="form-select" id="wiz-stage"><option value="">Select stage...</option>' +
      stageOpts +
      "</select></div>" +
      '<div class="form-group"><label class="form-label">Legal Structure</label>' +
      '<select class="form-select" id="wiz-legal"><option value="">Select...</option>' +
      legalOpts +
      "</select></div>" +
      "</div>";

    // Prefill on industry change
    document.getElementById("wiz-type").addEventListener("change", function () {
      var type = this.value;
      if (type && MABOS.INDUSTRY_PREFILLS[type]) {
        var prefill = MABOS.INDUSTRY_PREFILLS[type];
        wizardData.type = type;
        if (!wizardData._userEditedDesc) wizardData.description = prefill.description;
        if (!wizardData._userEditedGoals) wizardData.goals = prefill.goals.slice();
        if (!wizardData._userEditedSegments)
          wizardData.customer_segments = prefill.customer_segments.slice();
        if (!wizardData._userEditedVP)
          wizardData.value_propositions = prefill.value_propositions.slice();
        if (!wizardData._userEditedProducts)
          wizardData.products_services = prefill.products_services.slice();
        if (!wizardData._userEditedRevenue)
          wizardData.revenue_streams = prefill.revenue_streams.slice();
      }
    });
  }

  function renderStep2(body) {
    body.innerHTML =
      '<h3 class="wizard-step-title">Step 2: Description & Goals</h3>' +
      '<div class="form-group"><label class="form-label">Business Description</label>' +
      '<textarea class="form-textarea" id="wiz-desc" rows="4" placeholder="Describe what your business does...">' +
      MABOS.escapeHtml(wizardData.description || "") +
      "</textarea></div>" +
      '<div class="form-group"><label class="form-label">Key Goals</label><div id="wiz-goals-tags"></div></div>';

    MABOS._wizGoalsTags = MABOS.createTagInput(
      document.getElementById("wiz-goals-tags"),
      wizardData.goals || [],
      "Add a goal and press Enter...",
    );

    document.getElementById("wiz-desc").addEventListener("input", function () {
      wizardData._userEditedDesc = true;
    });
  }

  function renderStep3(body) {
    body.innerHTML =
      '<h3 class="wizard-step-title">Step 3: Market & Customers</h3>' +
      '<div class="form-group"><label class="form-label">Target Market</label>' +
      '<input type="text" class="form-input" id="wiz-market" value="' +
      MABOS.escapeHtml(wizardData.target_market || "") +
      '" placeholder="e.g., North American small businesses"></div>' +
      '<div class="form-group"><label class="form-label">Customer Segments</label><div id="wiz-segments-tags"></div></div>' +
      '<div class="form-group"><label class="form-label">Value Propositions</label><div id="wiz-vp-tags"></div></div>';

    MABOS._wizSegmentsTags = MABOS.createTagInput(
      document.getElementById("wiz-segments-tags"),
      wizardData.customer_segments || [],
      "Add segment and press Enter...",
    );
    MABOS._wizVPTags = MABOS.createTagInput(
      document.getElementById("wiz-vp-tags"),
      wizardData.value_propositions || [],
      "Add value proposition and press Enter...",
    );
  }

  function renderStep4(body) {
    body.innerHTML =
      '<h3 class="wizard-step-title">Step 4: Products & Revenue</h3>' +
      '<div class="form-group"><label class="form-label">Products / Services</label><div id="wiz-products-tags"></div></div>' +
      '<div class="form-group"><label class="form-label">Revenue Streams</label><div id="wiz-revenue-tags"></div></div>';

    MABOS._wizProductsTags = MABOS.createTagInput(
      document.getElementById("wiz-products-tags"),
      wizardData.products_services || [],
      "Add product/service and press Enter...",
    );
    MABOS._wizRevenueTags = MABOS.createTagInput(
      document.getElementById("wiz-revenue-tags"),
      wizardData.revenue_streams || [],
      "Add revenue stream and press Enter...",
    );
  }

  function renderStep5(body) {
    var type = MABOS.BUSINESS_TYPES.find(function (t) {
      return t.id === wizardData.type;
    });
    var stage = MABOS.BUSINESS_STAGES.find(function (s) {
      return s.id === wizardData.stage;
    });
    var legal = MABOS.LEGAL_STRUCTURES.find(function (l) {
      return l.id === wizardData.legal_structure;
    });
    var domainAgents = MABOS.DOMAIN_AGENTS[wizardData.type] || [];

    body.innerHTML =
      '<h3 class="wizard-step-title">Step 5: Review & Launch</h3>' +
      '<div class="review-section">' +
      '<div class="review-grid">' +
      '<div class="review-item"><span class="review-label">Business Name</span><span class="review-value">' +
      MABOS.escapeHtml(wizardData.name || "") +
      "</span></div>" +
      '<div class="review-item"><span class="review-label">Legal Name</span><span class="review-value">' +
      MABOS.escapeHtml(wizardData.legal_name || wizardData.name || "") +
      "</span></div>" +
      '<div class="review-item"><span class="review-label">Industry</span><span class="review-value">' +
      (type ? type.label : "-") +
      "</span></div>" +
      '<div class="review-item"><span class="review-label">Stage</span><span class="review-value">' +
      (stage ? stage.label : "MVP") +
      "</span></div>" +
      '<div class="review-item"><span class="review-label">Legal Structure</span><span class="review-value">' +
      (legal ? legal.label : "-") +
      "</span></div>" +
      '<div class="review-item"><span class="review-label">Business ID</span><span class="review-value"><code>' +
      slugify(wizardData.name || "") +
      "</code></span></div>" +
      "</div>" +
      '<div class="review-block"><strong>Description:</strong> ' +
      MABOS.escapeHtml(wizardData.description || "Not provided") +
      "</div>" +
      '<div class="review-block"><strong>Goals:</strong> ' +
      (wizardData.goals || [])
        .map(function (g) {
          return '<span class="badge badge-info">' + MABOS.escapeHtml(g) + "</span>";
        })
        .join(" ") +
      "</div>" +
      '<div class="review-block"><strong>Customer Segments:</strong> ' +
      (wizardData.customer_segments || [])
        .map(function (s) {
          return '<span class="badge badge-info">' + MABOS.escapeHtml(s) + "</span>";
        })
        .join(" ") +
      "</div>" +
      '<div class="review-block"><strong>Value Propositions:</strong> ' +
      (wizardData.value_propositions || [])
        .map(function (v) {
          return '<span class="badge badge-info">' + MABOS.escapeHtml(v) + "</span>";
        })
        .join(" ") +
      "</div>" +
      '<div class="review-block"><strong>Products/Services:</strong> ' +
      (wizardData.products_services || [])
        .map(function (p) {
          return '<span class="badge badge-info">' + MABOS.escapeHtml(p) + "</span>";
        })
        .join(" ") +
      "</div>" +
      '<div class="review-block"><strong>Revenue Streams:</strong> ' +
      (wizardData.revenue_streams || [])
        .map(function (r) {
          return '<span class="badge badge-info">' + MABOS.escapeHtml(r) + "</span>";
        })
        .join(" ") +
      "</div>" +
      '<div class="review-block"><strong>Core Agents:</strong> ' +
      MABOS.CORE_AGENT_ROLES.map(function (r) {
        return '<span class="badge badge-active">' + r.toUpperCase() + "</span>";
      }).join(" ") +
      "</div>" +
      (domainAgents.length > 0
        ? '<div class="review-block"><strong>Domain Agents:</strong> ' +
          domainAgents
            .map(function (a) {
              return '<span class="badge badge-info">' + MABOS.escapeHtml(a.name) + "</span>";
            })
            .join(" ") +
          "</div>"
        : "") +
      "</div>" +
      '<div class="form-group" style="margin-top:16px">' +
      '<label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="wiz-orchestrate" checked> ' +
      "Full orchestration (spawn domain agents, initialize desires, sync SBVR)</label></div>";
  }

  function saveCurrentStep() {
    switch (currentStep) {
      case 1:
        wizardData.name = (document.getElementById("wiz-name") || {}).value || "";
        wizardData.legal_name = (document.getElementById("wiz-legal-name") || {}).value || "";
        wizardData.type = (document.getElementById("wiz-type") || {}).value || "";
        wizardData.stage = (document.getElementById("wiz-stage") || {}).value || "";
        wizardData.legal_structure = (document.getElementById("wiz-legal") || {}).value || "";
        break;
      case 2:
        wizardData.description = (document.getElementById("wiz-desc") || {}).value || "";
        break;
      case 3:
        wizardData.target_market = (document.getElementById("wiz-market") || {}).value || "";
        break;
    }
  }

  function validateStep() {
    switch (currentStep) {
      case 1:
        var name = (document.getElementById("wiz-name") || {}).value || "";
        var type = (document.getElementById("wiz-type") || {}).value || "";
        if (!name.trim()) {
          alert("Business name is required.");
          return false;
        }
        if (!type) {
          alert("Please select an industry.");
          return false;
        }
        return true;
      default:
        return true;
    }
  }

  async function submitWizard() {
    saveCurrentStep();
    var btn = document.getElementById("wizard-submit");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Creating...";
    }

    var orchestrate = document.getElementById("wiz-orchestrate");
    var payload = {
      business_id: slugify(wizardData.name),
      name: wizardData.name,
      legal_name: wizardData.legal_name || wizardData.name,
      type: wizardData.type,
      description: wizardData.description || "",
      stage: wizardData.stage || "mvp",
      value_propositions: wizardData.value_propositions || [],
      customer_segments: wizardData.customer_segments || [],
      revenue_streams: wizardData.revenue_streams || [],
      products_services: wizardData.products_services || [],
      goals: wizardData.goals || [],
      target_market: wizardData.target_market || "",
      orchestrate: orchestrate ? orchestrate.checked : true,
    };

    try {
      var result = await MABOS.postJSON("/mabos/api/onboard", payload);
      if (result && result.ok) {
        // Refresh businesses and navigate to business detail
        await MABOS.loadBusinesses();
        MABOS.state.currentBusiness = payload.business_id;
        localStorage.setItem("mabos_current_business", payload.business_id);
        MABOS.navigate("businesses", { id: payload.business_id });
      } else {
        alert("Onboarding failed: " + (result ? result.error : "Unknown error"));
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Launch Business";
        }
      }
    } catch (err) {
      alert("Error: " + err.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Launch Business";
      }
    }
  }
})();
