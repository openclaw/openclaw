# Changelog

All notable changes to the Email Channel plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release of Email Channel plugin for OpenClaw
- IMAP email receiving with automatic polling (configurable interval)
- SMTP email sending for AI responses
- Sender whitelist functionality for security
- Persistent state management with:
  - Timestamp-based email search (SINCE)
  - Message-ID deduplication
  - Automatic cleanup (max 1000 Message-IDs)
- Session history integration with OpenClaw Dashboard
- Support for multiple email providers (Gmail, QQ, 163, Outlook, etc.)
- Comprehensive error handling and logging
- Support for both read and unread email processing

### Security

- No hardcoded credentials in source code
- Sender whitelist recommended for production use
- App-specific password support

## [1.0.0] - 2026-02-07

### Added

- Initial release
- Core IMAP/SMTP functionality
- State persistence system
- Message-ID deduplication
- Session history tracking
- Documentation and examples
