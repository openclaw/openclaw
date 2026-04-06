# Exec Approval Limitations

## Problem

Currently, exec approvals are based on hashing the full command string.

Example:

python email_sender.py --content-file Day_007.md  
python email_sender.py --content-file Day_008.md  

These generate different hashes, even though they execute the same script.

## Impact

- "Allow always" becomes ineffective
- Repeated approval prompts
- Poor experience for dynamic workflows

## Suggested Improvements

- Support executable-level trust (python.exe)
- Support script-level trust (email_sender.py)
- Support wildcard/pattern-based commands
- Persist approvals across restarts

## Related Issue

#61667