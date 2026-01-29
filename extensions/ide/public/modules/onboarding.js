// ============================================
// ONBOARDING MODULE - Interactive Tutorial
// ============================================
// Step-by-step walkthrough for new users

const Onboarding = {
  currentStep: 0,
  completed: false,
  overlay: null,
  tooltip: null,
  
  // Tutorial steps
  steps: [
    {
      target: '.activity-bar',
      title: 'Welcome to Clawd IDE! 🐾',
      content: 'This is your AI-native development environment. Let\'s take a quick tour of the key features.',
      position: 'right'
    },
    {
      target: '[data-panel="explorer"]',
      title: 'File Explorer',
      content: 'Browse and manage your project files here. Click folders to expand, files to open.',
      position: 'right'
    },
    {
      target: '[data-panel="search"]',
      title: 'Search',
      content: 'Search across all files in your project. Use Cmd+Shift+F for quick access.',
      position: 'right'
    },
    {
      target: '[data-panel="git"]',
      title: 'Git Integration',
      content: 'Stage, commit, push, and manage branches. AI can help write commit messages!',
      position: 'right'
    },
    {
      target: '[data-panel="ai"]',
      title: 'AI Chat',
      content: 'Chat with Clawd AI about your code. Use @file to include context, or ask anything!',
      position: 'right'
    },
    {
      target: '[data-panel="debug"]',
      title: 'Debugger',
      content: 'Set breakpoints, step through code, and inspect variables. Full Node.js debugging.',
      position: 'right'
    },
    {
      target: '[data-panel="dashboard"]',
      title: 'Dashboard',
      content: 'View project stats, TODOs, and recent activity at a glance.',
      position: 'right'
    },
    {
      target: '.editor-area',
      title: 'Editor',
      content: 'Write code with Monaco editor. Enjoy syntax highlighting, IntelliSense, and multi-cursor support.',
      position: 'left'
    },
    {
      target: '#chatPanel',
      title: 'AI Panel',
      content: 'The AI assistant lives here. It knows your codebase and can help with anything!',
      position: 'left'
    },
    {
      target: '.terminal-tabs',
      title: 'Terminal',
      content: 'Run commands, npm scripts, and more. Split into multiple panes for multitasking.',
      position: 'top'
    },
    {
      target: null, // Center screen
      title: 'Key Shortcuts',
      content: `
        <div class="onboarding-shortcuts">
          <div><kbd>Cmd+K</kbd> Inline AI Edit</div>
          <div><kbd>Cmd+P</kbd> Quick Open</div>
          <div><kbd>Cmd+Shift+F</kbd> Search All</div>
          <div><kbd>Cmd+\`</kbd> Toggle Terminal</div>
          <div><kbd>Cmd+?</kbd> All Shortcuts</div>
        </div>
      `,
      position: 'center'
    },
    {
      target: null,
      title: 'You\'re Ready! 🚀',
      content: 'Start coding and let Clawd AI help you along the way. You can restart this tour anytime from Settings.',
      position: 'center'
    }
  ],
  
  /**
   * Initialize onboarding
   */
  init() {
    this.completed = localStorage.getItem('clawd-ide-onboarding-done') === 'true';
    
    // Auto-start for first-time users
    if (!this.completed && !sessionStorage.getItem('onboarding-skipped')) {
      // Delay slightly to let app load
      setTimeout(() => this.start(), 1500);
    }
  },
  
  /**
   * Start the tutorial
   */
  start() {
    this.currentStep = 0;
    this.createOverlay();
    this.showStep(0);
  },
  
  /**
   * Create overlay elements
   */
  createOverlay() {
    // Remove existing
    this.destroy();
    
    // Overlay background
    this.overlay = document.createElement('div');
    this.overlay.className = 'onboarding-overlay';
    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.next();
    };
    document.body.appendChild(this.overlay);
    
    // Tooltip
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'onboarding-tooltip';
    document.body.appendChild(this.tooltip);
  },
  
  /**
   * Show a specific step
   */
  showStep(index) {
    if (index >= this.steps.length) {
      this.complete();
      return;
    }
    
    const step = this.steps[index];
    this.currentStep = index;
    
    // Remove previous highlight
    document.querySelectorAll('.onboarding-highlight').forEach(el => {
      el.classList.remove('onboarding-highlight');
    });
    
    let targetRect = null;
    
    if (step.target) {
      const target = document.querySelector(step.target);
      if (target) {
        target.classList.add('onboarding-highlight');
        targetRect = target.getBoundingClientRect();
        
        // Scroll into view if needed
        if (targetRect.top < 0 || targetRect.bottom > window.innerHeight) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetRect = target.getBoundingClientRect();
        }
      }
    }
    
    // Build tooltip content
    this.tooltip.innerHTML = `
      <div class="onboarding-header">
        <span class="onboarding-step">${index + 1}/${this.steps.length}</span>
        <h3>${step.title}</h3>
      </div>
      <div class="onboarding-body">
        ${step.content}
      </div>
      <div class="onboarding-footer">
        ${index > 0 ? '<button class="onboarding-btn secondary" onclick="Onboarding.prev()">← Back</button>' : ''}
        <button class="onboarding-btn secondary" onclick="Onboarding.skip()">Skip Tour</button>
        <button class="onboarding-btn primary" onclick="Onboarding.next()">
          ${index === this.steps.length - 1 ? 'Finish' : 'Next →'}
        </button>
      </div>
    `;
    
    // Position tooltip
    this.positionTooltip(step.position, targetRect);
    
    // Animate in
    setTimeout(() => this.tooltip.classList.add('visible'), 50);
  },
  
  /**
   * Position the tooltip relative to target
   */
  positionTooltip(position, targetRect) {
    const tooltip = this.tooltip;
    const padding = 20;
    
    tooltip.classList.remove('visible');
    tooltip.style.removeProperty('top');
    tooltip.style.removeProperty('left');
    tooltip.style.removeProperty('right');
    tooltip.style.removeProperty('bottom');
    tooltip.style.removeProperty('transform');
    
    if (!targetRect || position === 'center') {
      // Center on screen
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
      return;
    }
    
    const tooltipRect = tooltip.getBoundingClientRect();
    
    switch (position) {
      case 'right':
        tooltip.style.top = `${targetRect.top + targetRect.height / 2}px`;
        tooltip.style.left = `${targetRect.right + padding}px`;
        tooltip.style.transform = 'translateY(-50%)';
        break;
        
      case 'left':
        tooltip.style.top = `${targetRect.top + targetRect.height / 2}px`;
        tooltip.style.right = `${window.innerWidth - targetRect.left + padding}px`;
        tooltip.style.transform = 'translateY(-50%)';
        break;
        
      case 'top':
        tooltip.style.bottom = `${window.innerHeight - targetRect.top + padding}px`;
        tooltip.style.left = `${targetRect.left + targetRect.width / 2}px`;
        tooltip.style.transform = 'translateX(-50%)';
        break;
        
      case 'bottom':
        tooltip.style.top = `${targetRect.bottom + padding}px`;
        tooltip.style.left = `${targetRect.left + targetRect.width / 2}px`;
        tooltip.style.transform = 'translateX(-50%)';
        break;
    }
    
    // Clamp to viewport
    requestAnimationFrame(() => {
      const rect = tooltip.getBoundingClientRect();
      if (rect.right > window.innerWidth - 20) {
        tooltip.style.left = 'auto';
        tooltip.style.right = '20px';
        tooltip.style.transform = position === 'right' ? 'translateY(-50%)' : '';
      }
      if (rect.left < 20) {
        tooltip.style.left = '20px';
        tooltip.style.transform = position === 'left' ? 'translateY(-50%)' : '';
      }
    });
  },
  
  /**
   * Go to next step
   */
  next() {
    this.tooltip.classList.remove('visible');
    setTimeout(() => this.showStep(this.currentStep + 1), 150);
  },
  
  /**
   * Go to previous step
   */
  prev() {
    if (this.currentStep > 0) {
      this.tooltip.classList.remove('visible');
      setTimeout(() => this.showStep(this.currentStep - 1), 150);
    }
  },
  
  /**
   * Skip the tutorial
   */
  skip() {
    sessionStorage.setItem('onboarding-skipped', 'true');
    this.destroy();
  },
  
  /**
   * Complete the tutorial
   */
  complete() {
    localStorage.setItem('clawd-ide-onboarding-done', 'true');
    this.completed = true;
    this.destroy();
    showNotification('Tutorial complete! Happy coding! 🎉', 'success');
  },
  
  /**
   * Destroy overlay and tooltip
   */
  destroy() {
    document.querySelectorAll('.onboarding-highlight').forEach(el => {
      el.classList.remove('onboarding-highlight');
    });
    
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
  },
  
  /**
   * Restart the tutorial
   */
  restart() {
    localStorage.removeItem('clawd-ide-onboarding-done');
    sessionStorage.removeItem('onboarding-skipped');
    this.completed = false;
    this.start();
  }
};

// ============================================
// EXPORTS
// ============================================

window.Onboarding = Onboarding;
window.startOnboarding = () => Onboarding.start();
window.restartOnboarding = () => Onboarding.restart();
