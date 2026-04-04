# Wig Forge UX Research Notes

Last updated: April 4, 2026

This note turns current public product patterns into concrete rules for `wig-forge`.
The goal is not to imitate one product wholesale. It is to borrow the strongest pieces
for the loop we care about most:

`page object -> cutout -> randomized wearable drop -> desire -> grant -> bot identity`

## External references we studied

- Discord Orbs global launch, April 1, 2025:
  [discord.com/press-releases/discord-launches-orbs-globally](https://discord.com/press-releases/discord-launches-orbs-globally)
  Why it matters: Discord treats virtual goods as a social layer, not just a wallet.
- Discord Shop wishlist update, November 14, 2024:
  [discord.com/blog/save-and-display-your-faves-add-discord-shop-marvel-rivals-items-to-your-profiles-wishlist](https://discord.com/blog/save-and-display-your-faves-add-discord-shop-marvel-rivals-items-to-your-profiles-wishlist)
  Why it matters: desire, curation, and signaling are part of retention.
- Roblox creator avatar economy update, September 6, 2023:
  [corp.roblox.com/newsroom/2023/09/creators-are-earning-more-from-roblox-avatar-marketplace](https://corp.roblox.com/newsroom/2023/09/creators-are-earning-more-from-roblox-avatar-marketplace)
  Why it matters: avatar-first commerce expands when customization is the primary mental model.
- Duolingo streak milestone motion post, July 2, 2024:
  [blog.duolingo.com/streak-milestone-design-animation](https://blog.duolingo.com/streak-milestone-design-animation)
  Why it matters: celebrations should feel earned, short, and highly legible.
- Chrome extension side panel launch, May 11, 2023:
  [developer.chrome.com/blog/extension-side-panel-launch](https://developer.chrome.com/blog/extension-side-panel-launch)
  Why it matters: persistent companion UI is more natural than forcing everything into a popup.
- Material motion timing guidance:
  [m1.material.io/motion/duration-easing.html](https://m1.material.io/motion/duration-easing.html)
  Why it matters: state changes need a clear rhythm, not random animation lengths.
- Apple reduced motion guidance:
  [developer.apple.com/documentation/accessibility/enhancing-the-accessibility-of-your-swiftui-app](https://developer.apple.com/documentation/accessibility/enhancing-the-accessibility-of-your-swiftui-app)
  Why it matters: reward motion must degrade cleanly when users prefer reduced motion.

## Product call

The strongest version of `wig-forge` is not a market-first product.
It is a `reveal + collection room + wish wall` product first.

That means:

- The most important moment is the reveal right after capture.
- The most important room state is "what the bot is wearing now".
- The most important long-tail retention device is "what the bot still wants".
- The bazaar comes later, after identity and desire already matter.

## Information architecture

Phase 1 should be organized into five layers:

1. Forge Layer
   Capture target, cutout quality, slot override, mint confirmation.
2. Reveal Layer
   Latest item gets a full spotlight, rarity emphasis, and an immediate equip/gift decision.
3. Collection Layer
   The inventory is a room, not a table. Equipped items sit apart from the shelf.
4. Wish Layer
   Active desires and granted wishes turn rewards into a contract instead of a vague promise.
5. Bazaar Layer
   Trading, bundles, creator drops, and sponsored limiteds come only after the first four are sticky.

## Layout and visual direction

Recommended direction:

- Warm museum display, not dark cyber dashboard.
- Large artifact presentation before dense utility controls.
- One dominant object per view.
- Rarity expressed by material, lighting, trim, and motion before color labels.
- Utility controls stay present but visually secondary.

Design rules:

- The first viewport should feel like a display pedestal.
- The newest drop should always be visually privileged.
- Empty equipped slots should remain visible so the room implies missing rewards.
- Active wishes should live near the collection, not on a settings page.
- Browsing inventory should feel like curating a wardrobe, not managing files.

## Motion and choreography

Target timings for the full loop:

- Capture freeze: `80-120ms`
- Segmentation progress handoff: `180-240ms`
- Shared object-to-reveal transition: `260-320ms`
- Rarity accent or shimmer: `450-650ms`
- Equip or grant confirmation: `180-220ms`
- Reduced-motion fallback: crossfade only, no scale bounce or orbiting effects

Motion rules:

- One hero reveal is enough.
- Inventory interactions should use light movement and fast confirmation.
- The same item should keep continuity between grid card and spotlight.
- Celebrations should end quickly and hand control back.
- Reduced motion must remove flourish but preserve hierarchy.

## Playability and stickiness

The strongest retention levers for this product are:

- Daily low-friction forge opportunities
- A visible wish wall
- Set completion bonuses
- Non-expiring `wig`
- Shareable room or reward cards
- Limited seasonal collections

What to avoid:

- Too many currencies
- Loot-box framing without real attachment to the item
- Market features before the room itself feels alive
- Long reveal sequences that slow down repeated forging

## Recommended random drop system refinement

The drop system should feel lucky, but never arbitrary.

Suggested roll model:

- `source fidelity`
  Based on segmentation quality, image clarity, and silhouette confidence.
- `effort signal`
  Based on agent work quality, task completion, or operator-granted bonus.
- `novelty`
  Based on duplicate fingerprint decay and recent inventory similarity.
- `style fit`
  Based on tags, slot confidence, and palette coherence.
- `luck`
  A bounded random modifier that keeps the loop surprising.

Suggested rarity behavior:

- `common`
  Default result for routine or low-confidence captures.
- `uncommon`
  Good capture quality or useful style fit.
- `rare`
  High novelty or strong operator effort bonus.
- `epic`
  Very strong combined score plus uncommon material or trim seed.
- `mythic`
  Very rare peak roll, ideally with a unique effect treatment.

Anti-fatigue adjustments:

- Duplicate source decay over recent captures
- Daily first-forge bonus
- Near-miss messaging when an item almost rolled higher
- Slot balancing so the same slot does not dominate too often
- Set synergy so a new item can become more exciting if it completes a look

## Business expansion space

Once the base loop is strong, `wig-forge` can grow in these directions:

- Creator bazaar for user-made trims, outfits, and companions
- Brand or event limited drops
- Outfit bundles and set completion rewards
- Shared room links or social showrooms
- Internal company reward systems for work bots
- Physical merchandise bridge for popular digital sets

## Near-term build guidance

The next practical UI moves should be:

- Keep improving the room around `spotlight -> equip -> wish -> grant`.
- Move extension controls toward a persistent side panel instead of popup-only usage.
- Add share-ready room snapshots once the room composition is stable.
- Delay trading UI until collection and wishing data show repeat behavior.
