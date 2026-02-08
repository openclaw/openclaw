// ============================================
// OWASP AGENTIC TOP 10 POLICY PACK
// ============================================
//
// Additional rules based on OWASP Top 10 for
// Agentic Applications. All rule IDs prefixed
// with "owasp-" for clear identification.
// Rule count is dynamic - see logs for current count.
//
// Reference: https://genai.owasp.org
//
// ⚠️  WARNING: This pack is MORE RESTRICTIVE than the
// default policy pack. Some rules may block legitimate
// development workflows. Review before enabling:
//
// - owasp-block-pip-url blocks pip install from git URLs
// - owasp-block-npm-git blocks npm install from GitHub
// - owasp-block-systemd blocks systemctl commands
// - owasp-block-crontab blocks cron job management
// - owasp-block-vector-db protects RAG/embedding files
//
// Enable via: a2_owaspAgenticPack: true in config
// Or selectively copy rules to c_customRules
//
// ============================================


// ============================================
// OWASP ASI01: AGENT GOAL HIJACK PREVENTION
// ============================================

// Block eval in shell commands (dynamic code execution)
@id("owasp-block-shell-eval")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*eval *" ||
   context.params.command like "*$(*)*" && context.params.command like "*curl*")
};


// ============================================
// OWASP ASI02: TOOL MISUSE PREVENTION
// ============================================

// Block data exfiltration via DNS queries
@id("owasp-block-dns-exfil")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*nslookup*`*`*" ||
   context.params.command like "*dig*`*`*" ||
   context.params.command like "*host*$(*)*")
};

// Block socat (often used for tunneling/exfiltration)
@id("owasp-block-socat")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  context.params.command like "*socat*"
};

// Block scp/rsync to external hosts (data exfiltration)
@id("owasp-block-external-copy")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*scp *@*:*" ||
   context.params.command like "*rsync*@*:*") &&
  !(context.params.command like "*localhost*") &&
  !(context.params.command like "*127.0.0.1*")
};

// Block tar piped to network (archive exfiltration)
@id("owasp-block-tar-exfil")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*tar*|*curl*" ||
   context.params.command like "*tar*|*nc*" ||
   context.params.command like "*tar*|*netcat*")
};

// Block mass database dumps
@id("owasp-block-db-dump")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*mysqldump*--all-databases*" ||
   context.params.command like "*pg_dumpall*" ||
   context.params.command like "*mongodump*")
};


// ============================================
// OWASP ASI03: IDENTITY & PRIVILEGE ABUSE
// ============================================

// Block user account manipulation
@id("owasp-block-user-management")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*useradd*" ||
   context.params.command like "*userdel*" ||
   context.params.command like "*usermod*" ||
   context.params.command like "*adduser*" ||
   context.params.command like "*deluser*" ||
   context.params.command like "*groupadd*" ||
   context.params.command like "*passwd*")
};

// Block reading password/shadow files
@id("owasp-block-read-passwd")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/etc/passwd*" ||
   context.params.path like "*/etc/shadow*" ||
   context.params.path like "*/etc/sudoers*" ||
   context.params.path like "*/etc/gshadow*")
};

// Block reading browser credential stores
@id("owasp-block-browser-creds")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.config/google-chrome/*Login*" ||
   context.params.path like "*/.mozilla/firefox/*.default*/logins.json*" ||
   context.params.path like "*/Library/Application Support/Google/Chrome/*Login*" ||
   context.params.path like "*Keychain*")
};

// Block reading GPG private keys
@id("owasp-block-gpg-keys")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.gnupg/private*" ||
   context.params.path like "*/.gnupg/secring*" ||
   context.params.path like "*.asc" && context.params.path like "*private*")
};

// Block setuid/setgid manipulation
@id("owasp-block-setuid")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*chmod*+s*" ||
   context.params.command like "*chmod*u+s*" ||
   context.params.command like "*chmod*g+s*" ||
   context.params.command like "*chmod*4*" ||
   context.params.command like "*chmod*2*")
};


// ============================================
// OWASP ASI04: SUPPLY CHAIN ATTACK PREVENTION
// ============================================

// Block pip install from URLs (potential malicious packages)
@id("owasp-block-pip-url")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*pip*install*http://*" ||
   context.params.command like "*pip*install*https://*" ||
   context.params.command like "*pip*install*git+*")
};

// Block npm install from git URLs
@id("owasp-block-npm-git")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*npm*install*git://*" ||
   context.params.command like "*npm*install*git+*" ||
   context.params.command like "*npm*install*github:*")
};

// Block adding untrusted package repositories
@id("owasp-block-untrusted-repos")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*add-apt-repository*ppa:*" ||
   context.params.command like "*apt-key*add*" ||
   context.params.command like "*rpm*--import*")
};

// Block writing to package manager configs
@id("owasp-block-package-config-write")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/etc/apt/sources.list*" ||
   context.params.path like "*/etc/yum.repos.d/*" ||
   context.params.path like "*/.npmrc*" ||
   context.params.path like "*/.pip/pip.conf*")
};

// Block downloading and making files executable
@id("owasp-block-download-exec")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*wget*&&*chmod*+x*" ||
   context.params.command like "*curl*&&*chmod*+x*" ||
   context.params.command like "*curl*-o*;*chmod*")
};


// ============================================
// OWASP ASI05: UNEXPECTED CODE EXECUTION (RCE)
// ============================================

// Block Python exec/eval in commands
@id("owasp-block-python-exec")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*python*-c*exec(*" ||
   context.params.command like "*python*-c*eval(*" ||
   context.params.command like "*python*-c*compile(*" ||
   context.params.command like "*python*-c*__import__(*")
};

// Block Node.js eval in commands
@id("owasp-block-node-exec")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*node*-e*eval(*" ||
   context.params.command like "*node*-e*Function(*" ||
   context.params.command like "*node*-e*require(*child_process*")
};

// Block Ruby eval
@id("owasp-block-ruby-exec")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*ruby*-e*eval*" ||
   context.params.command like "*ruby*-e*system*" ||
   context.params.command like "*ruby*-e*exec*")
};

// Block Perl eval
@id("owasp-block-perl-exec")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*perl*-e*eval*" ||
   context.params.command like "*perl*-e*system*")
};

// Block pickle/marshal deserialization (Python RCE vector)
@id("owasp-block-pickle-load")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*pickle.load*" ||
   context.params.command like "*pickle.loads*" ||
   context.params.command like "*marshal.load*" ||
   context.params.command like "*yaml.load*" ||
   context.params.command like "*yaml.unsafe_load*")
};

// Block cron job manipulation (persistence)
@id("owasp-block-crontab")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*crontab*-e*" ||
   context.params.command like "*crontab*-r*" ||
   context.params.command like "*crontab*-l*|*" ||
   context.params.command like "*/etc/cron*")
};

// Block writing to cron directories
@id("owasp-block-cron-write")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/etc/cron*" ||
   context.params.path like "*/var/spool/cron*")
};

// Block systemd service manipulation (persistence)
@id("owasp-block-systemd")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*systemctl*enable*" ||
   context.params.command like "*systemctl*start*" ||
   context.params.command like "*systemctl*daemon-reload*")
};

// Block writing systemd unit files
@id("owasp-block-systemd-write")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/etc/systemd/*" ||
   context.params.path like "*/.config/systemd/*" ||
   context.params.path like "*.service")
};

// Block LaunchAgent/Daemon manipulation (macOS persistence)
@id("owasp-block-launchd")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/LaunchAgents/*" ||
   context.params.path like "*/LaunchDaemons/*")
};


// ============================================
// OWASP ASI06: MEMORY & CONTEXT POISONING
// ============================================

// Block access to agent memory/session files
@id("owasp-block-agent-memory")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/.openclaw/agents/*" ||
   context.params.path like "*/.openclaw/sessions/*")
};

// Block writing to agent internal state
@id("owasp-block-agent-config-write")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/.openclaw/agents/*" ||
   context.params.path like "*/.openclaw/sessions/*")
};

// Block editing agent internal state files
@id("owasp-block-agent-edit")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"edit" &&
  context has params && context.params has path &&
  (context.params.path like "*/.openclaw/agents/*" ||
   context.params.path like "*/.openclaw/sessions/*")
};

// Block access to vector database files (RAG poisoning)
@id("owasp-block-vector-db")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*.faiss*" ||
   context.params.path like "*.chroma*" ||
   context.params.path like "*/embeddings/*" ||
   context.params.path like "*/vector_store/*")
};

// Block writing to vector databases
@id("owasp-block-vector-db-write")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*.faiss*" ||
   context.params.path like "*.chroma*" ||
   context.params.path like "*/embeddings/*" ||
   context.params.path like "*/vector_store/*")
};


// ============================================
// OWASP ASI07: INTER-AGENT COMMUNICATION
// ============================================

// Block accessing MCP server configs
@id("owasp-block-mcp-config")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read" &&
  context has params && context.params has path &&
  (context.params.path like "*/mcp.json*" ||
   context.params.path like "*/.mcp/*" ||
   context.params.path like "*mcp-servers*")
};

// Block writing MCP configurations
@id("owasp-block-mcp-write")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/mcp.json*" ||
   context.params.path like "*/.mcp/*" ||
   context.params.path like "*mcp-servers*")
};

// Block writing agent card files (A2A protocol)
@id("owasp-block-agent-cards")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"write" &&
  context has params && context.params has path &&
  (context.params.path like "*/.well-known/agent.json*" ||
   context.params.path like "*agent-card*")
};


// ============================================
// OWASP ASI10: ROGUE AGENT PREVENTION
// ============================================

// Block spawning detached daemon processes
@id("owasp-block-agent-spawn")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*nohup*&*" ||
   context.params.command like "*disown*" ||
   context.params.command like "*screen*-dm*" ||
   context.params.command like "*tmux*new-session*-d*")
};

// Block fork bombs and process multiplication
@id("owasp-block-fork-bomb")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"exec" &&
  context has params && context.params has command &&
  (context.params.command like "*while true*do*fork*" ||
   context.params.command like "*while :*do*done*" ||
   context.params.command like "*for i in*; do*&*done*")
};


// ============================================
// OWASP ADDITIONAL OUTPUT REDACTION
// ============================================

// Redact OAuth tokens from output
@id("owasp-redact-oauth-tokens")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*access_token*" ||
   context.response like "*refresh_token*" ||
   context.response like "*bearer *" ||
   context.response like "*Bearer *")
};

// Redact JWT tokens from output
@id("owasp-redact-jwt")
forbid(principal, action, resource)
when {
  action == Sondera::Action::"read_result" &&
  context has response &&
  (context.response like "*eyJ*.*.*" ||
   context.response like "*JWT*=*")
};
