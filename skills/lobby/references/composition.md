# Editing the whole Lobby

The host displays one vertical list. Opening a component gives it the available
page height, including in landscape. The live square miniature clips the top
square area of the same retained document. Do not build another render instance,
video stream, screenshot loop, or authored preview crop. Do not mark a special
preview region. Host zoom is a temporary viewing adjustment, not a source edit.

Author fluid content for the available page, without a square height constraint.
Keep important information near the top so it is recognizable in the miniature.
Use layout flow and wrapping; scroll internally only when content exceeds the
available page. Do not configure sizeH, Auto Height, Change Height, or custom
resize controls for mobile Lobby presentation.

The page consists of board structure, component source, assets, data, and their
relationships. `dashboard` read exposes metadata and plugin props; `widget_read`
exposes stored HTML. Missing source does not mean an existing component can be
reconstructed from its title. Plugin and MCP widgets keep their own owners.

For a page-level change, inspect every affected component first. Keep stable names
and visual tokens, identify the requested changes, and preserve unrelated source
and state. The same theme does not grant access to another component's state or
credentials. Cross-component communication needs an advertised host contract;
cross-origin DOM access and guessed `postMessage` bridges are not substitutes.

Prepare complete replacements before writing. Multiple writes are not an atomic
page transaction; metadata/source reads are not compare-and-swap writes. If the
board changes during preparation, reread the affected source and reconcile. If a
multi-component change partially succeeds, name what changed and what remains.
Do not delete working components first or promise an automatic page rollback.

Changing a component's content owner (for example HTML to a native report) may
require removal and recreation. Do not use that destructive conversion as a
routine update; preserve the existing owner unless the request calls for it.

Verify collection/detail presentation, rotation, local interaction, and return
from zoom on the actual supported surface when available. A source review alone
does not establish any of those visual results.
